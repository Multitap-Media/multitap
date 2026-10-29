/**
 * What identifies a session's video file, for subtitle requests (see
 * okf:architecture/core-subtitles-and-player-state): the `videoHash`, `videoSize` and `filename` extras OpenSubtitles-style
 * addons match on.
 *
 * Taken from the playing stream's `behaviorHints` when the addon gave them; a
 * missing hash (and size) is asked of the engine (`/opensubHash`), which reads
 * the start and end of the source, so that is lazy (first subtitle list of the
 * session), bounded by a timeout, cached per session, and skipped silently on
 * an engine that lacks it. Nothing here logs a URL.
 */
import type { EngineHandle, EngineModule } from '../engines/module.ts';
import type { Clock } from '../lib/clock.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { Logger } from '../log.ts';
import type { SubtitleHints } from '../subtitles/index.ts';
import type { PlaybackSessionRecord, SessionRepository } from './repository.ts';

/** How long the engine may take to read the file's ends. */
export const SUBTITLE_HASH_TIMEOUT_MS = 8_000;
/** A hash found stays valid for the session's likely lifetime. */
export const SUBTITLE_HINTS_TTL_MS = 6 * 3_600_000;
/** A failed hash lookup is not retried for this long. */
export const SUBTITLE_HINTS_RETRY_MS = 60_000;
export const SUBTITLE_HINTS_MAX_ENTRIES = 1_000;

export interface SubtitleHintDeps {
  repo: Pick<SessionRepository, 'getStream'>;
  engines: Pick<EngineModule, 'openSubHash'>;
  clock: Clock;
  logger: Logger;
  timeoutMs?: number;
}

export class SubtitleHintResolver {
  readonly #o: SubtitleHintDeps;
  readonly #found: TtlCache<SubtitleHints>;
  readonly #missed: TtlCache<SubtitleHints>;
  readonly #inFlight = new Map<string, Promise<SubtitleHints>>();

  constructor(deps: SubtitleHintDeps) {
    this.#o = deps;
    this.#found = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_HINTS_TTL_MS,
      maxEntries: SUBTITLE_HINTS_MAX_ENTRIES,
    });
    this.#missed = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_HINTS_RETRY_MS,
      maxEntries: SUBTITLE_HINTS_MAX_ENTRIES,
    });
  }

  /** The hints known for the session; `{}` when it has no source yet or nothing is known. Never rejects. */
  async resolve(record: PlaybackSessionRecord, signal?: AbortSignal): Promise<SubtitleHints> {
    const cached = this.#found.get(record.id) ?? this.#missed.get(record.id);
    if (cached !== undefined) return cached;
    let pending = this.#inFlight.get(record.id);
    if (pending === undefined) {
      pending = this.#compute(record, signal).finally(() => this.#inFlight.delete(record.id));
      this.#inFlight.set(record.id, pending);
    }
    return pending;
  }

  async #compute(record: PlaybackSessionRecord, signal?: AbortSignal): Promise<SubtitleHints> {
    const hints: SubtitleHints = {};
    try {
      const hinted = (await this.#o.repo.getStream(record.id))?.behaviorHints;
      if (hinted?.videoHash !== undefined && hinted.videoHash !== '') {
        hints.videoHash = hinted.videoHash;
      }
      if (hinted?.videoSize !== undefined) hints.videoSize = hinted.videoSize;
      if (hinted?.filename !== undefined && hinted.filename !== '')
        hints.filename = hinted.filename;
    } catch (err) {
      this.#o.logger.warn({ sessionId: record.id, err }, 'subtitle hints: stream unreadable');
    }
    if (hints.videoHash !== undefined && hints.videoSize !== undefined) {
      this.#found.set(record.id, hints);
      return hints;
    }
    const handle: EngineHandle | undefined =
      record.status === 'ready' && record.engineId !== null && record.sid !== null
        ? { engineId: record.engineId, sid: record.sid }
        : undefined;
    const openSubHash = this.#o.engines.openSubHash?.bind(this.#o.engines);
    if (handle === undefined || openSubHash === undefined) {
      // Not ready yet (or no engine support): don't cache, a later list may do better.
      return hints;
    }
    const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? SUBTITLE_HASH_TIMEOUT_MS);
    try {
      const result = await openSubHash(
        handle,
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      );
      if (result !== undefined) {
        hints.videoHash ??= result.hash;
        hints.videoSize ??= result.size;
        this.#found.set(record.id, hints);
        return hints;
      }
    } catch (err) {
      // Never the error itself: it could name the source.
      this.#o.logger.info(
        { sessionId: record.id, engineId: handle.engineId, code: errorCode(err) },
        'subtitle hash unavailable',
      );
    }
    this.#missed.set(record.id, hints);
    return hints;
  }
}

function errorCode(err: unknown): string {
  return err instanceof Error ? err.name : 'unexpected';
}
