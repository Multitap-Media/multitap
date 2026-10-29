/**
 * Engine clients and health state (okf:concept/engine-descriptor, okf:architecture/engine-transport-and-health). One
 * {@link ServerGoClient} per engine descriptor, rebuilt when the descriptor's
 * transport or address changes; `online`/`lastSeen` as the health monitor
 * (health.ts) last saw them. Shared by the engine module and the monitor.
 */
import type { EngineDescriptor } from '@multitap/api';
import type { Db } from '../db/index.ts';
import type { Secret } from '../lib/secret.ts';
import {
  getEngine,
  getEngineProxyPassword,
  type EngineHealth,
  type EngineHealthView,
} from './index.ts';
import { createTransportFactory } from './lan-transport.ts';
import { createServerGoClient, engineSelfBase, type ServerGoTimeouts } from './server-go.ts';
import type { ServerGoClient } from './server-go-types.ts';
import type { EngineTransport, EngineTransportFactory } from './transport.ts';

export interface EngineRegistryOptions {
  db: Db;
  timeouts: ServerGoTimeouts;
  /** Defaults to the real transports (`lan`; `tunnel` fails until phase 5). */
  transportFactory?: EngineTransportFactory;
  /** TCP connect timeout of the default `lan` transport (`MULTITAP_ENGINE_CONNECT_TIMEOUT_MS`). */
  connectTimeoutMs?: number;
}

/** Called with an engine's id whenever one of its requests gets a 2xx response. */
export type EngineAnsweredListener = (engineId: string) => void;

export interface EngineEntry {
  engine: EngineDescriptor;
  client: ServerGoClient;
  /** `STREMIO_PROXY_PASSWORD` for `/proxy/stream` URLs; absent when none is set. */
  proxyPassword?: Secret;
}

interface CachedClient {
  fingerprint: string;
  client: ServerGoClient;
}

export class EngineRegistry implements EngineHealthView {
  readonly #db: Db;
  readonly #timeouts: ServerGoTimeouts;
  readonly #factory: EngineTransportFactory;
  readonly #clients = new Map<string, CachedClient>();
  readonly #health = new Map<string, EngineHealth>();
  readonly #answered = new Set<EngineAnsweredListener>();

  constructor(options: EngineRegistryOptions) {
    this.#db = options.db;
    this.#timeouts = options.timeouts;
    this.#factory =
      options.transportFactory ??
      createTransportFactory(
        options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.connectTimeoutMs },
      );
  }

  /**
   * Subscribes to engines answering requests (any request through a client
   * from this registry: control calls, playlists, segments). The health
   * monitor uses it to re-check an engine marked offline at once (health.ts).
   * Returns the unsubscribe function.
   */
  onAnswered(listener: EngineAnsweredListener): () => void {
    this.#answered.add(listener);
    return () => {
      this.#answered.delete(listener);
    };
  }

  /**
   * The descriptor, a client for it and its proxy password (okf:architecture/secrets-classes-and-engine-password, read on
   * every call so a change through the API or the CLI applies at once);
   * undefined for an unknown engine.
   */
  async get(engineId: string): Promise<EngineEntry | undefined> {
    const engine = await getEngine(this.#db, engineId);
    if (engine === undefined) {
      this.forget(engineId);
      return undefined;
    }
    const entry: EngineEntry = { engine, client: this.clientFor(engine) };
    const proxyPassword = await getEngineProxyPassword(this.#db, engineId);
    if (proxyPassword !== undefined) entry.proxyPassword = proxyPassword;
    return entry;
  }

  /**
   * A client for a descriptor, reused while its transport and address are
   * unchanged. When they change, the last health result was about the old
   * address, so the engine's health goes back to unknown (`lastSeen` is kept)
   * until the next check: a replaced engine isn't refused as offline.
   */
  clientFor(engine: Pick<EngineDescriptor, 'id' | 'transport' | 'address'>): ServerGoClient {
    const fingerprint = `${engine.transport}|${engine.address ?? ''}`;
    const cached = this.#clients.get(engine.id);
    if (cached?.fingerprint === fingerprint) return cached.client;
    const health = this.#health.get(engine.id);
    if (cached !== undefined && health !== undefined) {
      this.#health.set(engine.id, { online: false, lastSeen: health.lastSeen });
    }
    const client = createServerGoClient({
      engineId: engine.id,
      transport: this.#observed(engine.id, this.#factory(engine)),
      timeouts: this.#timeouts,
      selfBase: engineSelfBase(engine.address),
    });
    this.#clients.set(engine.id, { fingerprint, client });
    return client;
  }

  /**
   * The transport, telling {@link onAnswered} listeners about every 2xx
   * response. Only 2xx counts: a 5xx may come from something in front of the
   * engine, and the health probe's own non-200 answer must not count as the
   * engine being back.
   */
  #observed(engineId: string, transport: EngineTransport): EngineTransport {
    return {
      kind: transport.kind,
      request: async (path, init) => {
        const res = await transport.request(path, init);
        if (res.ok) {
          for (const listener of this.#answered) {
            try {
              listener(engineId);
            } catch {
              // A listener's failure is not the request's.
            }
          }
        }
        return res;
      },
    };
  }

  health(engineId: string): EngineHealth | undefined {
    return this.#health.get(engineId);
  }

  /** False only when the last check failed; undefined while unknown. */
  isOnline(engineId: string): boolean | undefined {
    const health = this.#health.get(engineId);
    return health?.checkedAt === undefined ? undefined : health.online;
  }

  /** Records a check result (health.ts). Returns the previous state. */
  recordHealth(engineId: string, health: EngineHealth): EngineHealth | undefined {
    const previous = this.#health.get(engineId);
    this.#health.set(engineId, health);
    return previous;
  }

  /** Drops a removed engine's client and health. */
  forget(engineId: string): void {
    this.#clients.delete(engineId);
    this.#health.delete(engineId);
  }
}
