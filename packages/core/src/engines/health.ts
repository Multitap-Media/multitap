/**
 * Per-engine health checks (phase 2 step 2): `GET /metrics` on every engine
 * with an address, every `MULTITAP_ENGINE_HEALTH_INTERVAL_MS` while it answers, and
 * with exponential backoff up to `MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS` while it
 * doesn't; a changed address or transport is checked at the next engine-list
 * sync (every interval), without the backoff. A success sets `online` and
 * writes `engines.last_seen`; every change of `online` publishes an
 * `engine.status` event and resets the client's cached capabilities (the
 * engine may have been upgraded).
 *
 * An engine marked offline that answers any other request (a segment through
 * the gateway, a control call) is re-checked at once rather than at the end of
 * its backoff, and its backoff is reset (okf:architecture/engine-transport-and-health). The answer only triggers the
 * check; the check alone sets `online`. One probe path keeps `last_seen`, the
 * event, the capability reset and the metrics in one place, and a single 2xx on
 * some path is weaker evidence than the probe (a request sent before the
 * engine went away can still complete). The probe costs one `/metrics` round
 * trip. Re-checks triggered this way run one at a time and at most once per
 * {@link RECHECK_MIN_GAP_MS}; answers in between are coalesced into one
 * re-check at the end of the gap.
 */
import type { EngineDescriptor } from '@multitap/api';
import type { Db } from '../db/index.ts';
import type { EventBus } from '../events/bus.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../log.ts';
import { listEngines } from './index.ts';
import type { EngineRegistry } from './registry.ts';
import { EngineTransportError } from './transport.ts';

/** Timer functions, injected so tests can drive time by hand. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface EngineHealthMonitorOptions {
  db: Db;
  registry: EngineRegistry;
  logger: Logger;
  clock: Clock;
  /** `engine.status` events go here when given (events/bus.ts). */
  bus?: Pick<EventBus, 'publish'>;
  /** Metrics registry to record engine health (optional). */
  metrics?: { updateEngineHealth(engineId: string, online: boolean): void } | undefined;
  intervalMs: number;
  timeoutMs: number;
  maxBackoffMs: number;
  timers?: Timers;
}

/** The shortest time between two re-checks triggered by an offline engine answering a request. */
export const RECHECK_MIN_GAP_MS = 5_000;

interface EngineLoop {
  timer: unknown;
  failures: number;
  running: boolean;
  /** `transport|address` as last listed; a change restarts the loop at once, without backoff. */
  target: string;
  /** A re-check after an answer is scheduled and hasn't started yet. */
  recheckDue: boolean;
  /** Set for {@link RECHECK_MIN_GAP_MS} after an answer-triggered re-check is scheduled. */
  gapTimer: unknown;
  /** The engine answered while a check ran or during the gap: re-check when possible. */
  answered: boolean;
}

const targetOf = (engine: Pick<EngineDescriptor, 'transport' | 'address'>): string =>
  `${engine.transport}|${engine.address ?? ''}`;

/** The delay before the next check after `failures` consecutive failures. */
export function healthDelay(failures: number, intervalMs: number, maxBackoffMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** (failures - 1), Math.max(maxBackoffMs, intervalMs));
}

export class EngineHealthMonitor {
  readonly #o: EngineHealthMonitorOptions;
  readonly #timers: Timers;
  readonly #loops = new Map<string, EngineLoop>();
  #syncTimer: unknown;
  #started = false;
  #unsubscribe: (() => void) | undefined;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: EngineHealthMonitorOptions) {
    this.#o = options;
    this.#timers = options.timers ?? realTimers;
  }

  /** Checks every engine now, then keeps checking; re-reads the engine list every interval. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#o.registry.onAnswered((engineId) => {
      this.#onAnswered(engineId);
    });
    this.#track(this.sync());
  }

  stop(): void {
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#syncTimer !== undefined) this.#timers.clearTimeout(this.#syncTimer);
    this.#syncTimer = undefined;
    for (const loop of this.#loops.values()) this.#clearLoop(loop);
    this.#loops.clear();
  }

  /** Resolves once in-flight checks and syncs have finished (tests). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Starts loops for new engines and stops those for removed ones. */
  async sync(): Promise<void> {
    let engines: EngineDescriptor[];
    try {
      engines = await listEngines(this.#o.db);
    } catch (err) {
      this.#o.logger.warn({ err }, 'engine health: listing engines failed');
      engines = [];
    }
    if (!this.#started) return;
    const ids = new Set(engines.map((e) => e.id));
    for (const [id, loop] of this.#loops) {
      if (!ids.has(id)) {
        this.#clearLoop(loop);
        this.#loops.delete(id);
        this.#o.registry.forget(id);
      }
    }
    for (const engine of engines) {
      const existing = this.#loops.get(engine.id);
      if (existing?.target === targetOf(engine)) continue;
      // New, or its address or transport changed (e.g. an address set on an engine
      // backed off for having none): check now rather than after the backoff.
      if (existing !== undefined) this.#clearLoop(existing);
      const loop: EngineLoop = {
        timer: undefined,
        failures: 0,
        running: false,
        target: targetOf(engine),
        recheckDue: false,
        gapTimer: undefined,
        answered: false,
      };
      this.#loops.set(engine.id, loop);
      this.#schedule(engine.id, loop, 0);
    }
    this.#syncTimer = this.#timers.setTimeout(() => {
      this.#track(this.sync());
    }, this.#o.intervalMs);
  }

  /** Checks one engine now (also used by tests). Returns whether it answered. */
  async check(engineId: string): Promise<boolean> {
    const { registry, logger, clock, db } = this.#o;
    const entry = await registry.get(engineId);
    if (entry === undefined) return false;
    let ok = false;
    let reason: string | undefined;
    if (entry.engine.address === null && entry.engine.transport === 'lan') {
      reason = 'no address';
    } else {
      try {
        const res = await entry.client.transport.request('/metrics', {
          timeoutMs: this.#o.timeoutMs,
        });
        try {
          await res.body?.cancel();
        } catch {
          // Already closed.
        }
        ok = res.status === 200;
        if (!ok) reason = `status ${String(res.status)}`;
      } catch (err) {
        reason = err instanceof EngineTransportError ? err.code : 'error';
      }
    }

    const now = clock();
    const previous = registry.health(engineId);
    const lastSeen = ok ? now : (previous?.lastSeen ?? (await this.#storedLastSeen(engineId)));
    registry.recordHealth(engineId, { online: ok, lastSeen, checkedAt: now });
    if (ok) {
      try {
        await db
          .updateTable('engines')
          .set({ last_seen: now })
          .where('id', '=', engineId)
          .execute();
      } catch (err) {
        logger.warn({ err, engineId }, 'engine health: storing last_seen failed');
      }
    }
    const changed = previous?.checkedAt === undefined || previous.online !== ok;
    if (changed) {
      if (ok) {
        entry.client.resetCapabilities();
        logger.info({ engineId }, 'engine online');
      } else {
        logger.warn({ engineId, reason }, 'engine offline');
      }
      this.#o.bus?.publish({
        type: 'engine.status',
        data: {
          engineId,
          online: ok,
          lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
        },
      });
    }
    this.#o.metrics?.updateEngineHealth(engineId, ok);
    return ok;
  }

  async #storedLastSeen(engineId: string): Promise<number | null> {
    const row = await this.#o.db
      .selectFrom('engines')
      .select('last_seen')
      .where('id', '=', engineId)
      .executeTakeFirst();
    return row?.last_seen ?? null;
  }

  #schedule(engineId: string, loop: EngineLoop, delayMs: number): void {
    loop.timer = this.#timers.setTimeout(() => {
      if (loop.running || this.#loops.get(engineId) !== loop) return;
      loop.running = true;
      loop.recheckDue = false;
      this.#track(
        this.check(engineId)
          .catch((err: unknown) => {
            this.#o.logger.warn({ err, engineId }, 'engine health check failed');
            return false;
          })
          .then((ok) => {
            loop.running = false;
            loop.failures = ok ? 0 : loop.failures + 1;
            if (ok) loop.answered = false;
            if (this.#started && this.#loops.get(engineId) === loop) {
              this.#schedule(
                engineId,
                loop,
                healthDelay(loop.failures, this.#o.intervalMs, this.#o.maxBackoffMs),
              );
              // It answered something while this check failed: try again soon.
              if (loop.answered) {
                loop.answered = false;
                this.#onAnswered(engineId);
              }
            }
          }),
      );
    }, delayMs);
  }

  /** An engine answered a request (registry.ts): reset its backoff, and re-check it if offline. */
  #onAnswered(engineId: string): void {
    if (!this.#started) return;
    const loop = this.#loops.get(engineId);
    if (loop === undefined) return;
    loop.failures = 0;
    if (this.#o.registry.isOnline(engineId) !== false) return;
    if (loop.recheckDue) return; // The scheduled check will see it.
    if (loop.running || loop.gapTimer !== undefined) {
      loop.answered = true;
      return;
    }
    loop.answered = false;
    loop.recheckDue = true;
    this.#timers.clearTimeout(loop.timer);
    this.#schedule(engineId, loop, 0);
    loop.gapTimer = this.#timers.setTimeout(() => {
      loop.gapTimer = undefined;
      if (!loop.answered || loop.running || this.#loops.get(engineId) !== loop) return;
      loop.answered = false;
      this.#onAnswered(engineId);
    }, RECHECK_MIN_GAP_MS);
  }

  #clearLoop(loop: EngineLoop): void {
    this.#timers.clearTimeout(loop.timer);
    if (loop.gapTimer !== undefined) this.#timers.clearTimeout(loop.gapTimer);
    loop.gapTimer = undefined;
  }

  #track(promise: Promise<unknown>): void {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise));
  }
}
