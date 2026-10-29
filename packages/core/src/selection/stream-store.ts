/**
 * `selection/stream-store`: the raw `Stream` behind each candidate key the API
 * has handed out (okf:architecture/normalized-addon-types, okf:architecture/secrets-policy). Clients only ever see candidates;
 * phase 2's sessions look the stream up here by key. Raw streams can carry
 * debrid tokens, so they live only in this memory and are never logged.
 */
import type { ItemFlag } from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';
import type { Clock } from '../auth/keys.ts';
import { TtlCache } from '../lib/ttl-cache.ts';

export const STREAM_STORE_TTL_MS = 6 * 3_600_000;
export const STREAM_STORE_MAX_ENTRIES = 10_000;

export interface StoredStream {
  addonId: string;
  /** The addon's name, for what a session records as a profile's last source. */
  addonName?: string | undefined;
  /** The request's content type and video id, so a session can say what it plays. */
  type: string;
  videoId: string;
  stream: Stream;
  /** The candidate's engine affinity (`SourceCandidate.requiresEngine`), which wins at session create (okf:decision/auto-select-and-fallback). */
  requiresEngine?: string | undefined;
  /** The candidate's safety flags (`SourceCandidate.flags`), when it was listed flagged. */
  flags?: ItemFlag[] | undefined;
}

export interface StreamStoreOptions {
  clock: Clock;
  ttlMs?: number;
  maxEntries?: number;
}

export class StreamStore {
  readonly #cache: TtlCache<StoredStream>;

  constructor(options: StreamStoreOptions) {
    this.#cache = new TtlCache({
      clock: options.clock,
      ttlMs: options.ttlMs ?? STREAM_STORE_TTL_MS,
      maxEntries: options.maxEntries ?? STREAM_STORE_MAX_ENTRIES,
    });
  }

  get size(): number {
    return this.#cache.size;
  }

  /** Keeps (or refreshes) the stream for a candidate key. */
  put(key: string, entry: StoredStream): void {
    this.#cache.set(key, entry);
  }

  /** The stream for a candidate key, if it was listed recently enough. */
  get(key: string): StoredStream | undefined {
    return this.#cache.get(key);
  }
}
