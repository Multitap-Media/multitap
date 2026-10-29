import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestSchema, type Manifest } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { CapabilityIndex } from '../src/addons/capabilities.ts';
import { CircuitBreaker } from '../src/addons/circuit-breaker.ts';
import { normalizeManifestUrl } from '../src/addons/collection.ts';
import { ResponseCache } from '../src/addons/response-cache.ts';
import { FIXTURES_DIR, type FakeFixture } from './fakes/addon.ts';
import { manualClock } from './helpers.ts';

function manifestOf(fixture: FakeFixture): Manifest {
  return ManifestSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES_DIR, fixture, 'manifest.json'), 'utf8')),
  );
}

describe('CircuitBreaker', () => {
  it('opens after 5 consecutive failures and refuses requests', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker(clock);
    for (let i = 0; i < 4; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.failure();
      expect(breaker.state).toBe('closed');
    }
    expect(breaker.tryAcquire()).toBe(true);
    breaker.failure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('counts only consecutive failures', () => {
    const breaker = new CircuitBreaker(manualClock());
    for (let i = 0; i < 4; i++) breaker.failure();
    breaker.success();
    for (let i = 0; i < 4; i++) breaker.failure();
    expect(breaker.state).toBe('closed');
  });

  it('lets exactly one trial through after 60 s, and closes on its success', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) breaker.failure();
    clock.advance(59_999);
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.success();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('reopens for another 60 s when the trial fails', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) breaker.failure();
    clock.advance(60_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.failure();
    expect(breaker.state).toBe('open');
    clock.advance(59_999);
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('frees the trial slot when the trial is cancelled', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, resetMs: 10 });
    breaker.failure();
    clock.advance(10);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.cancel();
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
  });
});

describe('ResponseCache', () => {
  it('honours cacheMaxAge, staleRevalidate and staleError', () => {
    const clock = manualClock();
    const cache = new ResponseCache<string>(clock, 10);
    cache.set('k', 'v', { cacheMaxAge: 10, staleRevalidate: 5, staleError: 60 });
    expect(cache.get('k')).toEqual({ value: 'v', use: 'fresh' });
    clock.advance(10_000);
    expect(cache.get('k')?.use).toBe('revalidate');
    clock.advance(5_000);
    expect(cache.get('k')?.use).toBe('on-error');
    clock.advance(55_000);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("doesn't store responses without cacheMaxAge", () => {
    const cache = new ResponseCache<string>(manualClock(), 10);
    expect(cache.set('k', 'v', {})).toBe(false);
    expect(cache.set('k', 'v', { cacheMaxAge: 0, staleError: 100 })).toBe(false);
    expect(cache.get('k')).toBeUndefined();
  });

  it('is bounded, evicting the least recently used entry', () => {
    const cache = new ResponseCache<number>(manualClock(), 2);
    cache.set('a', 1, { cacheMaxAge: 60 });
    cache.set('b', 2, { cacheMaxAge: 60 });
    cache.get('a');
    cache.set('c', 3, { cacheMaxAge: 60 });
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.get('c')?.value).toBe(3);
  });

  it('caps lifetimes at 7 days and drops entries by prefix', () => {
    const clock = manualClock();
    const cache = new ResponseCache<number>(clock, 10);
    cache.set('x\u0000a', 1, { cacheMaxAge: 30 * 86_400 });
    cache.set('y\u0000a', 2, { cacheMaxAge: 60 });
    cache.deletePrefix('y\u0000');
    expect(cache.get('y\u0000a')).toBeUndefined();
    clock.advance(7 * 86_400_000);
    expect(cache.get('x\u0000a')).toBeUndefined();
  });
});

describe('CapabilityIndex', () => {
  const addons = [
    { id: 'cinemeta', enabled: true, manifest: manifestOf('cinemeta') },
    { id: 'youtube', enabled: true, manifest: manifestOf('youtube') },
    { id: 'torrentio', enabled: true, manifest: manifestOf('torrentio-public') },
    { id: 'easynews', enabled: true, manifest: manifestOf('easynews') },
    { id: 'disabled', enabled: false, manifest: manifestOf('torrentio-rd') },
  ];
  const index = new CapabilityIndex(addons);
  const ids = (
    resource: string,
    type: string,
    id: string,
    extra = [] as { name: string; value: string }[],
  ) => index.match({ resource, type, id, extra }).map((a) => a.id);

  it('routes by resource, type and id prefix, in collection order, enabled only', () => {
    expect(ids('meta', 'movie', 'tt1375666')).toEqual(['cinemeta']);
    expect(ids('meta', 'channel', 'yt_id:UCq')).toEqual(['youtube']);
    expect(ids('meta', 'channel', 'tt1375666')).toEqual([]);
    expect(ids('stream', 'movie', 'tt1375666')).toEqual(['torrentio', 'easynews']);
    expect(ids('stream', 'anime', 'kitsu:1')).toEqual(['torrentio']);
    expect(ids('stream', 'channel', 'yt_id:UCq')).toEqual([]);
    expect(ids('subtitles', 'movie', 'tt1375666')).toEqual([]);
  });

  it('routes catalogs by type, id and extras', () => {
    expect(ids('catalog', 'movie', 'top')).toEqual(['cinemeta']);
    expect(ids('catalog', 'movie', 'top', [{ name: 'search', value: 'dune' }])).toEqual([
      'cinemeta',
    ]);
    // `year` requires `genre`; `imdbRating` doesn't accept `search`.
    expect(ids('catalog', 'movie', 'year')).toEqual([]);
    expect(ids('catalog', 'movie', 'imdbRating', [{ name: 'search', value: 'x' }])).toEqual([]);
    expect(ids('catalog', 'channel', 'top', [{ name: 'search', value: 'x' }])).toEqual(['youtube']);
  });

  it('lists the catalogs of enabled addons in collection order', () => {
    const catalogs = index.catalogs().map((c) => `${c.addonId}:${c.type}/${c.id}`);
    expect(catalogs[0]).toBe('cinemeta:movie/top');
    expect(catalogs).toContain('youtube:channel/top');
    expect(catalogs.findIndex((c) => c.startsWith('youtube'))).toBeGreaterThan(
      catalogs.findLastIndex((c) => c.startsWith('cinemeta')),
    );
  });
});

describe('normalizeManifestUrl', () => {
  it('reads stremio:// as https:// and drops the fragment', () => {
    expect(normalizeManifestUrl(' stremio://Example.com/a/manifest.json#x ').href).toBe(
      'https://example.com/a/manifest.json',
    );
  });

  it.each([
    ['not a url', 'invalid-url'],
    ['ftp://example.com/manifest.json', 'invalid-url'],
    ['https://example.com/stremio/v1', 'unsupported-transport'],
  ])('rejects %s', (input, kind) => {
    expect(() => normalizeManifestUrl(input)).toThrow(expect.objectContaining({ kind }));
  });
});
