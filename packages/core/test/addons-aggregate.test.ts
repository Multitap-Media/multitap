import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { loadConfig } from '../src/config.ts';
import { startFakeAddon, type FakeAddon, type FakeAddonOptions } from './fakes/addon.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setup(env: Record<string, string> = {}) {
  const db = await migratedMemoryDb();
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '300',
    MULTITAP_ADDON_TIMEOUT_META_MS: '300',
    MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '300',
    ...env,
  });
  const service = new AddonService({ config, db, logger: log.logger, clock });
  const install = async (options: FakeAddonOptions) => {
    const fake = await startFakeAddon(options);
    fakes.push(fake);
    const record = await service.collection.add(fake.manifestUrl);
    return { fake, record };
  };
  return { service, clock, log, install };
}

describe('aggregate', () => {
  it('asks only the addons whose manifests support the request, in collection order', async () => {
    const t = await setup();
    const cinemeta = await t.install({ fixture: 'cinemeta' });
    const youtube = await t.install({ fixture: 'youtube' });
    const torrentio = await t.install({ fixture: 'torrentio-public' });
    const easynews = await t.install({ fixture: 'easynews' });

    const meta = await t.service.aggregate('meta', 'movie', 'tt1375666');
    expect(meta.addons.map((a) => [a.addonName, a.status])).toEqual([['Cinemeta', 'ok']]);
    expect(meta.items).toHaveLength(1);
    expect(meta.items[0]).toMatchObject({ id: 'tt1375666', name: 'Inception' });

    const streams = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(streams.addons.map((a) => [a.addonId, a.status])).toEqual([
      [torrentio.record.id, 'ok'],
      [easynews.record.id, 'ok'],
    ]);
    const torrentioStreams = streams.addons[0]?.items ?? [];
    expect(torrentioStreams).toHaveLength(20);
    // Kept exactly as returned: addon order, then each addon's own order.
    expect(streams.items).toEqual(streams.addons.flatMap((a) => a.items));

    const channel = await t.service.aggregate('meta', 'channel', 'yt_id:UCq-Fj5jknLsUf-MWSy4_brA');
    expect(channel.addons.map((a) => a.addonId)).toEqual([youtube.record.id]);
    expect(channel.items[0]?.id).toBe('yt_id:UCq-Fj5jknLsUf-MWSy4_brA');

    const search = await t.service.aggregate('catalog', 'movie', 'top', [
      { name: 'search', value: 'dune' },
    ]);
    expect(search.addons.map((a) => a.addonId)).toEqual([cinemeta.record.id]);
    expect(search.items.length).toBeGreaterThan(0);

    // Nobody serves subtitles; YouTube doesn't get IMDb ids; Cinemeta doesn't get streams.
    expect((await t.service.aggregate('subtitles', 'movie', 'tt1375666')).addons).toEqual([]);
    expect(youtube.fake.resourceRequests()).toEqual([
      '/meta/channel/yt_id:UCq-Fj5jknLsUf-MWSy4_brA.json',
    ]);
    expect(cinemeta.fake.resourceRequests()).toEqual([
      '/meta/movie/tt1375666.json',
      '/catalog/movie/top/search=dune.json',
    ]);
  });

  it('skips disabled addons and honours an addon filter', async () => {
    const t = await setup();
    const a = await t.install({ fixture: 'torrentio-public' });
    const b = await t.install({ fixture: 'torrentio-rd' });
    await t.service.collection.setEnabled(a.record.id, false);
    const result = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(result.addons.map((x) => x.addonId)).toEqual([b.record.id]);

    await t.service.collection.setEnabled(a.record.id, true);
    const filtered = await t.service.aggregate('stream', 'movie', 'tt1375666', [], {
      addonIds: [a.record.id],
    });
    expect(filtered.addons.map((x) => x.addonId)).toEqual([a.record.id]);
  });

  it('returns partial results when an addon times out or fails', async () => {
    const t = await setup();
    const slow = await t.install({ fixture: 'torrentio-public', latencyMs: 2_000 });
    const broken = await t.install({ fixture: 'torrentio-rd', mode: 'error' });
    const good = await t.install({ fixture: 'easynews' });

    const started = performance.now();
    const result = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.addons.map((a) => [a.addonId, a.status, a.errorCode])).toEqual([
      [slow.record.id, 'timeout', 'timeout'],
      [broken.record.id, 'error', 'http-status'],
      [good.record.id, 'ok', undefined],
    ]);
    expect(result.items).toEqual(result.addons[2]?.items);
    expect(result.items.length).toBeGreaterThan(0);

    // Only the code, host and addon id are logged.
    const failures = t.log.lines().filter((l) => l.msg === 'addon request failed');
    expect(failures.map((l) => [l.addonId, l.code, l.host])).toEqual(
      expect.arrayContaining([
        [slow.record.id, 'timeout', '127.0.0.1'],
        [broken.record.id, 'http-status', '127.0.0.1'],
      ]),
    );
  });

  it('reports a wrong kind of response as an error', async () => {
    const t = await setup();
    await t.install({ fixture: 'easynews', routes: { 'stream/movie/tt1': { metas: [] } } });
    const result = await t.service.aggregate('stream', 'movie', 'tt1');
    expect(result.addons[0]).toMatchObject({ status: 'error', errorCode: 'unexpected-response' });
  });

  it('counts invalid items as dropped and keeps the valid ones', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public', mode: 'malformed' });
    await t.install({ fixture: 'cinemeta', mode: 'malformed' });

    const streams = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(streams.addons[0]).toMatchObject({ status: 'ok', dropped: 2 });
    expect(streams.addons[0]?.items).toHaveLength(20);
    expect(streams.dropped).toBe(2);

    const meta = await t.service.aggregate('meta', 'movie', 'tt1375666');
    expect(meta.addons[0]).toMatchObject({ status: 'error', errorCode: 'validation' });
    expect(t.log.lines().some((l) => l.dropped === 2)).toBe(true);
  });

  it('dedupes catalog metas by id across addons, first addon wins', async () => {
    const t = await setup();
    const first = await t.install({ fixture: 'cinemeta' });
    await t.install({ fixture: 'cinemeta', prefix: '/copy', manifest: { name: 'Cinemeta copy' } });
    const result = await t.service.aggregate('catalog', 'movie', 'top');
    expect(result.addons).toHaveLength(2);
    const perAddon = result.addons[0]?.items.length ?? 0;
    expect(perAddon).toBeGreaterThan(0);
    expect(result.items).toHaveLength(perAddon);
    expect(result.items).toEqual(result.addons.find((a) => a.addonId === first.record.id)?.items);
  });

  it('opens the circuit after 5 failures and retries after 60 s', async () => {
    const t = await setup();
    const { fake } = await t.install({ fixture: 'easynews', mode: 'error' });
    for (let i = 0; i < 5; i++) {
      const result = await t.service.aggregate('stream', 'movie', 'tt1375666');
      expect(result.addons[0]?.status).toBe('error');
    }
    expect(fake.resourceRequests()).toHaveLength(5);

    const open = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(open.addons[0]).toMatchObject({ status: 'circuit-open', items: [] });
    expect(open.addons[0]?.errorCode).toBeUndefined();
    expect(fake.resourceRequests()).toHaveLength(5);

    t.clock.advance(60_000);
    fake.set({ mode: 'ok' });
    const retried = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(retried.addons[0]?.status).toBe('ok');
    expect(fake.resourceRequests()).toHaveLength(6);
  });

  it("doesn't count 404s towards the circuit", async () => {
    const t = await setup();
    const { fake, record } = await t.install({ fixture: 'easynews', mode: 'not-found' });
    for (let i = 0; i < 7; i++) await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(fake.resourceRequests()).toHaveLength(7);
    expect(t.service.clients.circuitState(record.id)).toBe('closed');
  });

  it('serves responses from cache for cacheMaxAge, then revalidates in the background', async () => {
    const t = await setup();
    // Torrentio: cacheMaxAge 3600, staleRevalidate 14400, staleError 604800.
    const { fake } = await t.install({ fixture: 'torrentio-public' });
    const first = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(first.addons[0]?.cache).toBe('miss');
    const second = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(second.addons[0]?.cache).toBe('fresh');
    expect(second.items).toEqual(first.items);
    expect(fake.resourceRequests()).toHaveLength(1);

    t.clock.advance(3_600_000);
    const stale = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(stale.addons[0]?.cache).toBe('stale');
    await t.service.clients.idle();
    expect(fake.resourceRequests()).toHaveLength(2);
    const refreshed = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(refreshed.addons[0]?.cache).toBe('fresh');
  });

  it('serves a stale response within staleError when the addon fails', async () => {
    const t = await setup();
    const { fake } = await t.install({ fixture: 'torrentio-public' });
    await t.service.aggregate('stream', 'movie', 'tt1375666');
    t.clock.advance((3_600 + 14_400) * 1000);
    fake.set({ mode: 'error' });
    const result = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(result.addons[0]).toMatchObject({ status: 'ok', cache: 'stale' });
    expect(result.items).toHaveLength(20);
    expect(fake.resourceRequests()).toHaveLength(2);

    t.clock.advance(604_800 * 1000);
    const expired = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(expired.addons[0]?.status).toBe('error');
  });

  it("doesn't cache responses without cacheMaxAge", async () => {
    const t = await setup();
    // Cinemeta's meta responses carry no cache hints.
    const { fake } = await t.install({ fixture: 'cinemeta' });
    await t.service.aggregate('meta', 'movie', 'tt1375666');
    await t.service.aggregate('meta', 'movie', 'tt1375666');
    expect(fake.resourceRequests()).toHaveLength(2);
  });

  it('forgets cached responses when an addon is removed', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'torrentio-public' });
    await t.service.aggregate('stream', 'movie', 'tt1375666');
    await t.service.collection.remove(record.id);
    const result = await t.service.aggregate('stream', 'movie', 'tt1375666');
    expect(result.addons).toEqual([]);
  });
});
