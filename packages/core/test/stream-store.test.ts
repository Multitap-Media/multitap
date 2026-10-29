import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/lib/ttl-cache.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { manualClock } from './helpers.ts';

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    const clock = manualClock();
    const cache = new TtlCache<string>({ clock, ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 'A');
    clock.advance(999);
    expect(cache.get('a')).toBe('A');
    clock.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used over maxEntries', () => {
    const clock = manualClock();
    const cache = new TtlCache<number>({ clock, ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([1, undefined, 3]);
  });

  it('keeps the total weight under maxWeight, expired entries first', () => {
    const clock = manualClock();
    const cache = new TtlCache<string>({
      clock,
      ttlMs: 1000,
      maxEntries: 100,
      maxWeight: 10,
      weigh: (value) => value.length,
    });
    cache.set('old', 'xxxx');
    clock.advance(500);
    cache.set('a', 'aaaa');
    clock.advance(600); // `old` has expired, `a` hasn't.
    cache.set('b', 'bbbbbb');
    expect(cache.weight).toBe(10);
    expect([cache.get('a'), cache.get('b')]).toEqual(['aaaa', 'bbbbbb']);
    expect(cache.set('huge', 'x'.repeat(11))).toBe(false);
    cache.set('c', 'cc');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.weight).toBeLessThanOrEqual(10);
  });
});

describe('StreamStore', () => {
  it('keeps streams by candidate key, for 6 hours by default and up to its bound', () => {
    const clock = manualClock();
    const store = new StreamStore({ clock, maxEntries: 2 });
    const stream = StreamSchema.parse({ infoHash: 'a'.repeat(40), fileIdx: 1 });
    store.put('k1', { addonId: 'x', type: 'movie', videoId: 'tt1', stream });
    expect(store.get('k1')?.stream).toBe(stream);
    clock.advance(6 * 3_600_000 - 1);
    expect(store.get('k1')).toBeDefined();
    clock.advance(1);
    expect(store.get('k1')).toBeUndefined();

    for (const key of ['a', 'b', 'c']) {
      store.put(key, { addonId: 'x', type: 'movie', videoId: 'tt1', stream });
    }
    expect(store.size).toBe(2);
    expect(store.get('a')).toBeUndefined();
  });
});
