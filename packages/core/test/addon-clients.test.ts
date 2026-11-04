// AddonClients against a scripted fetchResource: health verdicts, Retry-After,
// in-flight sharing across forget(), and what the response cache keeps.
import {
  AddonHttpStatusError,
  parseResourceResponse,
  parseRetryAfter,
  type ParsedResourceResponse,
} from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { AddonClients, isHealthFailure, type ResourceFetcher } from '../src/addons/client.ts';
import { manualClock, memoryLogger } from './helpers.ts';

const addon = {
  id: 'a1',
  manifestUrl: 'https://addon.example.com/manifest.json',
  host: 'addon.example.com',
};
const path = { resource: 'stream', type: 'movie', id: 'tt1' };
const timeoutsMs = { catalog: 1000, meta: 1000, streams: 1000, subtitles: 1000 };

function parsed(body: unknown): ParsedResourceResponse {
  const result = parseResourceResponse(body);
  if (!result.success) throw new Error(result.message);
  return result.data;
}

function clients(fetchResource: ResourceFetcher, clock = manualClock()) {
  return new AddonClients({
    logger: memoryLogger().logger,
    clock,
    timeoutsMs,
    cacheEntries: 100,
    fetchResource,
    breaker: { failureThreshold: 5, resetMs: 60_000 },
  });
}

describe('AddonClients health', () => {
  it('counts a 429 towards the circuit, like a 5xx', async () => {
    expect(isHealthFailure(new AddonHttpStatusError('h', 429))).toBe(true);
    expect(isHealthFailure(new AddonHttpStatusError('h', 503))).toBe(true);
    expect(isHealthFailure(new AddonHttpStatusError('h', 404))).toBe(false);
    let calls = 0;
    const c = clients(() => {
      calls += 1;
      return Promise.reject(new AddonHttpStatusError('addon.example.com', 429));
    });
    for (let i = 0; i < 5; i++) await c.request(addon, path);
    expect(c.circuitState(addon.id)).toBe('open');
    expect(await c.request(addon, path)).toEqual({ status: 'circuit-open' });
    expect(calls).toBe(5);
  });

  it("keeps the circuit open for a 429's or 503's Retry-After", async () => {
    const clock = manualClock();
    let calls = 0;
    const c = clients(() => {
      calls += 1;
      return Promise.reject(new AddonHttpStatusError('addon.example.com', 503, 120_000));
    }, clock);
    await c.request(addon, path);
    expect(c.circuitState(addon.id)).toBe('open');
    clock.advance(119_999);
    expect(await c.request(addon, path)).toEqual({ status: 'circuit-open' });
    clock.advance(1);
    expect(c.circuitState(addon.id)).toBe('half-open');
    expect(calls).toBe(1);
  });

  it('ignores a Retry-After on other statuses', async () => {
    const c = clients(() =>
      Promise.reject(new AddonHttpStatusError('addon.example.com', 500, 120_000)),
    );
    await c.request(addon, path);
    expect(c.circuitState(addon.id)).toBe('closed');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it.each([
    ['120', 120_000],
    [' 0 ', 0],
    ['Wed, 04 Nov 2026 12:01:00 GMT', 60_000],
    ['Wed, 04 Nov 2026 11:00:00 GMT', 0], // in the past
    [null, undefined],
    ['', undefined],
    ['-5', undefined],
    ['1.5', undefined],
    ['soon', undefined],
    ['9'.repeat(40), undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('AddonClients in-flight requests', () => {
  it("doesn't join a request made before forget()", async () => {
    const pending: ((data: ParsedResourceResponse) => void)[] = [];
    const c = clients(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const before = c.request(addon, path);
    c.forget(addon.id); // the addon was disabled or its manifest changed
    const after = c.request(addon, path);
    expect(pending).toHaveLength(2);
    // The old request finishing doesn't drop the new one from the in-flight map.
    pending[0]?.(parsed({ streams: [] }));
    await before;
    const joined = c.request(addon, path);
    expect(pending).toHaveLength(2);
    pending[1]?.(parsed({ streams: [{ url: 'https://a.example.com/1' }] }));
    expect(await after).toEqual(await joined);
  });
});

describe('AddonClients cache', () => {
  it("keeps dropped items' count but not their validation issues", async () => {
    const data = parsed({
      streams: [{ url: 'https://a.example.com/1' }, { name: 'no source' }, { url: 42 }],
      cacheMaxAge: 60,
    });
    expect(data.dropped.every((d) => d.issues.length > 0)).toBe(true);
    const c = clients(() => Promise.resolve(data));
    const first = await c.request(addon, path);
    const cached = await c.request(addon, path);
    expect(cached).toMatchObject({ status: 'ok', cache: 'fresh' });
    for (const result of [first, cached]) {
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.data.dropped.map((d) => d.index)).toEqual([1, 2]);
      expect(result.data.dropped.every((d) => d.issues.length === 0)).toBe(true);
    }
  });
});
