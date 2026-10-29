import type { ResourceResponseCache } from '@multitap/addon-protocol';
import type { Clock } from '../auth/keys.ts';

/** Longest any response is kept, whatever an addon asks for (7 days). */
export const MAX_CACHE_SECONDS = 7 * 86_400;

/**
 * How a cached entry may be used right now, per the SDK's cache hints (which
 * follow HTTP's `max-age`, `stale-while-revalidate` and `stale-if-error`):
 * - `fresh`: within `cacheMaxAge`; serve it, don't ask the addon.
 * - `revalidate`: within `cacheMaxAge + staleRevalidate`; serve it and refresh
 *   it in the background.
 * - `on-error`: within `cacheMaxAge + staleError`; ask the addon, and serve it
 *   only if that fails.
 */
export type CacheUse = 'fresh' | 'revalidate' | 'on-error';

interface Entry<T> {
  value: T;
  storedAt: number;
  freshMs: number;
  revalidateMs: number;
  errorMs: number;
}

const clampSeconds = (s: number | undefined) => Math.min(s ?? 0, MAX_CACHE_SECONDS) * 1000;

/**
 * A bounded in-memory cache of addon responses, least recently used first out.
 * Responses without `cacheMaxAge` aren't stored.
 */
export class ResponseCache<T> {
  readonly #clock: Clock;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(clock: Clock, maxEntries: number) {
    this.#clock = clock;
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Stores a response if its hints allow; returns whether it was stored. */
  set(key: string, value: T, hints: ResourceResponseCache): boolean {
    const freshMs = clampSeconds(hints.cacheMaxAge);
    if (freshMs <= 0 || this.#maxEntries === 0) {
      this.#entries.delete(key);
      return false;
    }
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      storedAt: this.#clock(),
      freshMs,
      revalidateMs: freshMs + clampSeconds(hints.staleRevalidate),
      errorMs: freshMs + clampSeconds(hints.staleError),
    });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return true;
  }

  /** The entry and how it may be used, or `undefined` if there's none usable. */
  get(key: string): { value: T; use: CacheUse } | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const age = this.#clock() - entry.storedAt;
    let use: CacheUse | undefined;
    if (age < entry.freshMs) use = 'fresh';
    else if (age < entry.revalidateMs) use = 'revalidate';
    else if (age < entry.errorMs) use = 'on-error';
    if (use === undefined) {
      this.#entries.delete(key);
      return undefined;
    }
    // Touch: most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { value: entry.value, use };
  }

  /** Drops every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }
}
