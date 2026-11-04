import type { Clock } from '../auth/keys.ts';

export interface TtlCacheOptions<V> {
  clock: Clock;
  /** How long an entry lives after it was last set. */
  ttlMs: number;
  /** Most entries kept; the least recently used go first. */
  maxEntries: number;
  /** Largest total weight kept (e.g. bytes), with {@link weigh}. Default: unlimited. */
  maxWeight?: number;
  /** An entry's weight. Default 1. */
  weigh?: (value: V) => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  weight: number;
}

/** Longest wait between two scans for expired entries. */
const MAX_SWEEP_INTERVAL_MS = 60_000;

/**
 * A small in-memory map with a time to live and a size bound, least recently
 * used first out. Expired entries are dropped when they're read, and when the
 * cache is over its bounds: a scan for them runs at most once per sweep
 * interval (the TTL, at most a minute), and otherwise the least recently used
 * go, so a write into a full cache costs O(1), not a scan of every entry.
 */
export class TtlCache<V> {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxWeight: number;
  readonly #weigh: (value: V) => number;
  readonly #entries = new Map<string, Entry<V>>();
  readonly #sweepIntervalMs: number;
  #weight = 0;
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: TtlCacheOptions<V>) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY;
    this.#weigh = options.weigh ?? (() => 1);
    this.#sweepIntervalMs = Math.min(Math.max(options.ttlMs, 0), MAX_SWEEP_INTERVAL_MS);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Total weight of the entries held. */
  get weight(): number {
    return this.#weight;
  }

  /** Stores `value`, replacing any entry for `key`. An entry heavier than the whole budget isn't stored. */
  set(key: string, value: V): boolean {
    this.delete(key);
    const weight = this.#weigh(value);
    if (this.#maxEntries <= 0 || weight > this.#maxWeight) return false;
    this.#entries.set(key, { value, expiresAt: this.#clock() + this.#ttlMs, weight });
    this.#weight += weight;
    this.#evict();
    return true;
  }

  /** The live value for `key`; reading it makes it the most recently used. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#clock()) {
      this.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#weight -= entry.weight;
  }

  #evict(): void {
    if (this.#entries.size <= this.#maxEntries && this.#weight <= this.#maxWeight) return;
    // Expired entries first (when a scan is due), then the least recently used.
    const now = this.#clock();
    if (now - this.#lastSweep >= this.#sweepIntervalMs) {
      this.#lastSweep = now;
      for (const [key, entry] of this.#entries) {
        if (entry.expiresAt <= now) this.delete(key);
      }
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries && this.#weight <= this.#maxWeight) break;
      this.delete(key);
    }
  }
}
