import {
  CatalogPageSchema,
  CatalogRefSchema,
  MetaResultSchema,
  SourceListSchema,
  SubtitleListSchema,
  type SourceList,
} from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { putEngine } from '../src/engines/index.ts';
import { HOME_ENGINE, addHomeEngine } from './engine-fixture.ts';
import { createApp, openApiDocument } from '../src/http/app.ts';
import { PROBLEM_CONTENT_TYPE } from '../src/http/problem.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import {
  startFakeAddon,
  SUBTITLES_MANIFEST,
  type FakeAddon,
  type FakeAddonOptions,
} from './fakes/addon.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

/** Stands in for a debrid key in a configured addon's URL. */
const SECRET = 'sk-SECRET-DEBRID-KEY-8c1f';

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setup(options: { subtitleMaxBytes?: number } = {}) {
  const db = await migratedMemoryDb();
  await addHomeEngine(db);
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '400',
    MULTITAP_ADDON_TIMEOUT_META_MS: '400',
    MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '400',
    MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS: '400',
    // The fake addons serve their subtitle files from loopback.
    MULTITAP_ADDON_PRIVATE_ALLOW: '127.0.0.1',
  });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const streams = new StreamStore({ clock });
  const subtitleDeps: ConstructorParameters<typeof SubtitleService>[0] = {
    addons,
    clock,
    logger: log.logger,
    guard: addons.guard,
  };
  if (options.subtitleMaxBytes !== undefined) subtitleDeps.maxBytes = options.subtitleMaxBytes;
  const subtitles = new SubtitleService(subtitleDeps);
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams,
    subtitles,
    metrics: new MetricsRegistry(),
  });
  const key = (await createApiKey(db, { scope: 'client', label: 'client' }, clock)).key;
  const bodies: string[] = [];
  const get = async (path: string) => {
    const res = await app.request(path, { headers: bearer(key) });
    const text = await res.text();
    bodies.push(text);
    return {
      status: res.status,
      type: res.headers.get('Content-Type'),
      text,
      json: () => JSON.parse(text) as unknown,
    };
  };
  const install = async (opts: FakeAddonOptions) => {
    const fake = await startFakeAddon({ prefix: `/${SECRET}`, ...opts });
    fakes.push(fake);
    const record = await addons.collection.add(fake.manifestUrl);
    return { fake, record };
  };
  return { db, log, clock, config, addons, streams, app, key, get, install, bodies };
}

describe('GET /v1/catalogs', () => {
  it('lists the catalogs of enabled addons in collection order', async () => {
    const t = await setup();
    const youtube = await t.install({ fixture: 'youtube' });
    const cinemeta = await t.install({ fixture: 'cinemeta' });
    await t.install({ fixture: 'torrentio-public' });

    const res = await t.get('/v1/catalogs');
    expect(res.status).toBe(200);
    const catalogs = (res.json() as unknown[]).map((c) => CatalogRefSchema.parse(c));
    expect(catalogs.map((c) => [c.addonId, c.type, c.id])).toEqual([
      [youtube.record.id, 'channel', 'top'],
      [youtube.record.id, 'channel', 'videos'],
      [cinemeta.record.id, 'movie', 'top'],
      [cinemeta.record.id, 'series', 'top'],
      [cinemeta.record.id, 'movie', 'year'],
      [cinemeta.record.id, 'series', 'year'],
      [cinemeta.record.id, 'movie', 'imdbRating'],
      [cinemeta.record.id, 'series', 'imdbRating'],
      [cinemeta.record.id, 'series', 'last-videos'],
      [cinemeta.record.id, 'series', 'calendar-videos'],
    ]);
    const top = catalogs[2];
    expect(top).toMatchObject({ addonName: 'Cinemeta', name: 'Popular' });
    expect(top?.extra.map((e) => [e.name, e.isRequired, e.optionsLimit])).toEqual([
      ['genre', false, 1],
      ['search', false, 1],
      ['skip', false, 1],
    ]);
    expect(top?.extra[0]?.options).toContain('Horror');
    expect(catalogs[4]?.extra[0]).toMatchObject({ name: 'genre', isRequired: true });

    await t.addons.collection.setEnabled(youtube.record.id, false);
    const after = (await t.get('/v1/catalogs')).json() as { addonId: string }[];
    expect(after.every((c) => c.addonId === cinemeta.record.id)).toBe(true);
  });
});

describe('GET /v1/catalog/{addonId}/{type}/{id}', () => {
  it('returns a page of metas with the addon status', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'cinemeta' });
    const res = await t.get(`/v1/catalog/${record.id}/movie/top`);
    expect(res.status).toBe(200);
    const page = CatalogPageSchema.parse(res.json());
    expect(page.addon).toEqual({
      addonId: record.id,
      addonName: 'Cinemeta',
      status: 'ok',
      count: page.metas.length,
      dropped: 0,
    });
    expect(page.metas.length).toBeGreaterThan(10);
    expect(page.metas[0]).toMatchObject({ type: 'movie', posterShape: 'poster' });
    expect(page.metas[0]?.id).toMatch(/^tt\d+$/);
    // Only the DTO's fields: nothing addon-specific passes through.
    expect(Object.keys(page.metas[0] ?? {})).not.toContain('imdb_id');
    expect(Object.keys(page.metas[0] ?? {})).not.toContain('trailerStreams');
  });

  it('accepts search, skip and genre when the catalog declares them', async () => {
    const t = await setup();
    const { record, fake } = await t.install({ fixture: 'cinemeta' });
    const search = await t.get(`/v1/catalog/${record.id}/movie/top?search=dune`);
    expect(search.status).toBe(200);
    expect(CatalogPageSchema.parse(search.json()).metas.length).toBeGreaterThan(0);
    const genre = await t.get(`/v1/catalog/${record.id}/movie/top?genre=Horror`);
    expect(genre.status).toBe(200);
    const skip = await t.get(`/v1/catalog/${record.id}/series/top?skip=100`);
    expect(skip.status).toBe(200);
    expect(CatalogPageSchema.parse(skip.json()).metas.length).toBeGreaterThan(0);
    expect(fake.resourceRequests()).toEqual([
      '/catalog/movie/top/search=dune.json',
      '/catalog/movie/top/genre=Horror.json',
      '/catalog/series/top/skip=100.json',
    ]);
  });

  it('rejects extras the catalog does not declare, bad values and missing required ones', async () => {
    const t = await setup();
    const { record, fake } = await t.install({ fixture: 'cinemeta' });
    const cases: [string, RegExp][] = [
      // `imdbRating` declares genre and skip only.
      [`/v1/catalog/${record.id}/movie/imdbRating?search=dune`, /does not accept: search/],
      [`/v1/catalog/${record.id}/movie/top?foo=bar`, /does not accept: foo/],
      [`/v1/catalog/${record.id}/movie/top?genre=NotAGenre`, /one of the catalog's options/],
      [`/v1/catalog/${record.id}/movie/top?genre=Horror&genre=Comedy`, /./],
      [`/v1/catalog/${record.id}/movie/year`, /requires 'genre'/],
      [`/v1/catalog/${record.id}/movie/top?skip=ten`, /validation/],
      [`/v1/catalog/${record.id}/movie/top?search=`, /validation/],
    ];
    for (const [path, detail] of cases) {
      const res = await t.get(path);
      expect(res.status, path).toBe(400);
      expect(res.type).toBe(PROBLEM_CONTENT_TYPE);
      expect((res.json() as { detail: string }).detail, path).toMatch(detail);
    }
    // A required extra that is given passes; repeated values up to optionsLimit are accepted.
    fake.set({ emptyWhenUnknown: true });
    expect((await t.get(`/v1/catalog/${record.id}/movie/year?genre=2020`)).status).toBe(200);
    const ids = 'lastVideosIds=tt0903747&lastVideosIds=tt0944947';
    expect((await t.get(`/v1/catalog/${record.id}/series/last-videos?${ids}`)).status).toBe(200);
    expect(fake.resourceRequests()).toEqual([
      '/catalog/movie/year/genre=2020.json',
      '/catalog/series/last-videos/lastVideosIds=tt0903747&lastVideosIds=tt0944947.json',
    ]);
  });

  it('is a 404 for an unknown addon, catalog or a disabled addon', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'cinemeta' });
    expect((await t.get('/v1/catalog/nope/movie/top')).status).toBe(404);
    expect((await t.get(`/v1/catalog/${record.id}/movie/nope`)).status).toBe(404);
    await t.addons.collection.setEnabled(record.id, false);
    expect((await t.get(`/v1/catalog/${record.id}/movie/top`)).status).toBe(404);
  });

  it('answers 200 with the status when the addon fails', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'cinemeta', mode: 'error' });
    const res = await t.get(`/v1/catalog/${record.id}/movie/top`);
    expect(res.status).toBe(200);
    expect(CatalogPageSchema.parse(res.json())).toEqual({
      metas: [],
      addon: {
        addonId: record.id,
        addonName: 'Cinemeta',
        status: 'error',
        errorCode: 'http-status',
        count: 0,
        dropped: 0,
      },
    });
  });
});

describe('GET /v1/meta/{type}/{id}', () => {
  it('returns the normalized meta and the addons asked', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'cinemeta' });
    const res = await t.get('/v1/meta/series/tt0903747');
    expect(res.status).toBe(200);
    const result = MetaResultSchema.parse(res.json());
    expect(result.addonId).toBe(record.id);
    expect(result.addons).toEqual([
      { addonId: record.id, addonName: 'Cinemeta', status: 'ok', count: 1, dropped: 0 },
    ]);
    const { meta } = result;
    expect(meta).toMatchObject({ id: 'tt0903747', type: 'series', name: 'Breaking Bad' });
    expect(meta.videos[0]).toMatchObject({ id: 'tt0903747:1:1', season: 1, episode: 1 });
    expect(meta.videos[0]?.title).toBe('Pilot');
    expect(meta.trailers[0]).toEqual({ ytId: 'VFLkMDEO-Xc', title: 'Breaking Bad' });
    expect(meta.links.length).toBeGreaterThan(0);
    expect(meta.behaviorHints).toMatchObject({ isLive: false, hasScheduledVideos: true });
    expect(Object.keys(meta)).not.toContain('tvdb_id');
  });

  it('drops deep links that carry an addon URL, which can hold its configuration', async () => {
    const t = await setup();
    const { fake } = await t.install({ fixture: 'cinemeta' });
    // AIOMetadata's genre links name its own (configured) transport URL, URL-encoded.
    const transport = encodeURIComponent(fake.manifestUrl);
    const links = [
      {
        name: 'Drama',
        category: 'Genres',
        url: `stremio:///discover/${transport}/series/top?genre=Drama`,
      },
      {
        name: 'Raw',
        category: 'Genres',
        url: `stremio:///discover/${fake.manifestUrl}/series/top`,
      },
      { name: 'Jane Doe', category: 'Cast', url: 'stremio:///search?search=Jane%20Doe' },
      { name: '9.5', category: 'imdb', url: 'https://imdb.com/title/tt0903747' },
    ];
    fake.set({
      routes: {
        'meta/series/tt0903747': {
          meta: { id: 'tt0903747', type: 'series', name: 'Breaking Bad', links },
        },
      },
    });
    const res = await t.get('/v1/meta/series/tt0903747');
    expect(res.status).toBe(200);
    const { meta } = MetaResultSchema.parse(res.json());
    expect(meta.links.map((l) => l.name)).toEqual(['Jane Doe', '9.5']);
    expect(res.text).not.toContain(SECRET);
  });

  it('falls back to the next addon when the first one fails', async () => {
    const t = await setup();
    const broken = await t.install({
      fixture: 'cinemeta',
      mode: 'error',
      manifest: { id: 'broken.meta', name: 'Broken' },
    });
    const good = await t.install({ fixture: 'cinemeta' });
    const res = await t.get('/v1/meta/movie/tt1375666');
    expect(res.status).toBe(200);
    const result = MetaResultSchema.parse(res.json());
    expect(result.addonId).toBe(good.record.id);
    expect(result.meta.name).toBe('Inception');
    expect(result.addons.map((a) => [a.addonId, a.status, a.count])).toEqual([
      [broken.record.id, 'error', 0],
      [good.record.id, 'ok', 1],
    ]);
  });

  it('is a 404 when no addon returns a meta', async () => {
    const t = await setup();
    await t.install({ fixture: 'cinemeta', mode: 'not-found' });
    const res = await t.get('/v1/meta/movie/tt1375666');
    expect(res.status).toBe(404);
    expect(res.type).toBe(PROBLEM_CONTENT_TYPE);
    expect((await t.get('/v1/meta/movie/nothing-serves-this')).status).toBe(404);
  });
});

describe('GET /v1/streams/{type}/{videoId}', () => {
  const streams = (res: { json: () => unknown }): SourceList => SourceListSchema.parse(res.json());

  it('adds explain only on request, and it sums to the score', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public' });
    const plain = streams(await t.get('/v1/streams/movie/tt1375666'));
    expect(plain.candidates.every((c) => c.explain === undefined)).toBe(true);
    const explained = streams(await t.get('/v1/streams/movie/tt1375666?explain=true'));
    expect(explained.candidates.map((c) => ({ ...c, explain: undefined }))).toEqual(
      plain.candidates,
    );
    for (const c of explained.candidates) {
      const total = (c.explain?.contributions ?? []).reduce((a, x) => a + x.points, 0);
      expect(total).toBe(c.score);
      expect(c.explain?.playability.playable).toBe(c.playable);
    }
  });

  it('lists candidates in addon order by default, and by rank with sort=rank', async () => {
    const t = await setup();
    const torrentio = await t.install({ fixture: 'torrentio-public' });
    const easynews = await t.install({ fixture: 'easynews' });

    const byAddon = streams(await t.get('/v1/streams/movie/tt1375666'));
    expect(byAddon).toMatchObject({ engine: 'home', highRes: 'off', sort: 'addon' });
    expect(byAddon.addons).toEqual([
      { addonId: torrentio.record.id, addonName: 'Torrentio', status: 'ok', count: 20, dropped: 0 },
      {
        addonId: easynews.record.id,
        addonName: easynews.record.manifest.name,
        status: 'ok',
        count: 6,
        dropped: 0,
      },
    ]);
    expect(byAddon.candidates).toHaveLength(26);
    expect(byAddon.candidates.slice(0, 20).every((c) => c.addonId === torrentio.record.id)).toBe(
      true,
    );
    expect(byAddon.candidates.slice(20).every((c) => c.kind === 'http')).toBe(true);

    const byRank = streams(await t.get('/v1/streams/movie/tt1375666?sort=rank'));
    expect(byRank.sort).toBe('rank');
    // The same candidates, nothing hidden, ordered playable first then by score.
    expect(byRank.candidates.map((c) => c.key).sort()).toEqual(
      byAddon.candidates.map((c) => c.key).sort(),
    );
    const ordered = byRank.candidates.map((c) => [Number(c.playable), c.score] as const);
    for (let i = 1; i < ordered.length; i++) {
      const [pa, sa] = ordered[i - 1] ?? [0, 0];
      const [pb, sb] = ordered[i] ?? [0, 0];
      expect(pa > pb || (pa === pb && sa >= sb)).toBe(true);
    }
    expect(byRank.candidates.map((c) => c.key)).not.toEqual(byAddon.candidates.map((c) => c.key));
  });

  it('marks 4K by the highRes policy', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public' });
    const off = streams(await t.get('/v1/streams/movie/tt1375666?highRes=off'));
    const uhdOff = off.candidates.filter((c) => c.parsed.height === 2160);
    expect(uhdOff.length).toBeGreaterThan(0);
    for (const c of uhdOff) {
      expect(c.playable).toBe(false);
      expect(c.unplayableReason).toBe('too-high');
      expect(c.playableWhen).toBeUndefined();
    }
    const prepare = streams(await t.get('/v1/streams/movie/tt1375666?highRes=prepareOnly'));
    expect(prepare.highRes).toBe('prepareOnly');
    for (const c of prepare.candidates.filter((x) => x.parsed.height === 2160)) {
      expect(c.playableWhen).toBe('prepared');
      if (c.parsed.dvProfile !== 5) expect(c.playable).toBe(true);
    }
    for (const c of prepare.candidates.filter((x) => (x.parsed.height ?? 0) <= 1080)) {
      expect(c.playableWhen === 'live' || !c.playable).toBe(true);
    }
  });

  it('ranks for the named engine and rejects an unknown one', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public' });
    await putEngine(t.db, 'big', {
      ...HOME_ENGINE,
      capabilities: { ...HOME_ENGINE.capabilities, liveMaxHeight: 2160 },
    });
    const big = streams(await t.get('/v1/streams/movie/tt1375666?engine=big'));
    expect(big.engine).toBe('big');
    expect(
      big.candidates.filter((c) => c.parsed.height === 2160).map((c) => c.playableWhen),
    ).toEqual(expect.arrayContaining(['live']));

    const unknown = await t.get('/v1/streams/movie/tt1375666?engine=nope');
    expect(unknown.status).toBe(400);
    expect(unknown.type).toBe(PROBLEM_CONTENT_TYPE);
    expect((await t.get('/v1/streams/movie/tt1375666?engine=Not_An_Id')).status).toBe(400);
    expect((await t.get('/v1/streams/movie/tt1375666?highRes=max')).status).toBe(400);
    expect((await t.get('/v1/streams/movie/tt1375666?sort=score')).status).toBe(400);
  });

  it('takes series episode ids, with or without encoded colons', async () => {
    const t = await setup();
    const { fake } = await t.install({ fixture: 'torrentio-public' });
    const encoded = streams(await t.get('/v1/streams/series/tt0903747%3A1%3A1'));
    expect(encoded.candidates).toHaveLength(20);
    const plain = streams(await t.get('/v1/streams/series/tt0903747:1:1'));
    expect(plain.candidates.map((c) => c.key)).toEqual(encoded.candidates.map((c) => c.key));
    expect(fake.resourceRequests()[0]).toBe('/stream/series/tt0903747:1:1.json');
  });

  it("scores other episodes low with the item's meta, and applies ranking settings at once", async () => {
    const t = await setup();
    await t.install({ fixture: 'cinemeta' });
    await t.install({ fixture: 'easynews' });
    const list = streams(await t.get('/v1/streams/series/tt0903747:1:1?sort=rank'));
    const files = list.candidates.map((c) => c.title.split('\n')[0] ?? '');
    // Nothing hidden; the S01E01 releases first, then S02 and S01E06.
    expect(files).toHaveLength(5);
    expect(files.slice(0, 2).every((f) => /S0?1E01\./.test(f))).toBe(true);
    expect(files.slice(2).every((f) => !/S0?1E01\./.test(f))).toBe(true);
    // The same release, E01 against E06: only the mismatch penalty apart.
    const scoreOf = (re: RegExp) => list.candidates.find((c) => re.test(c.title))?.score ?? NaN;
    expect(scoreOf(/S01E01\.1080p\.BluRay\.REMUX/) - scoreOf(/S01E06\.1080p\.BluRay\.REMUX/)).toBe(
      10_000,
    );

    // A changed weight applies to the next source list, without a restart.
    const before = list.candidates.map((c) => c.score);
    const admin = (await createApiKey(t.db, { scope: 'admin', label: 'admin' }, t.clock)).key;
    const patched = await t.app.request('/v1/admin/ranking', {
      method: 'PATCH',
      headers: { ...bearer(admin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers: { http: 2500 } }),
    });
    expect(patched.status).toBe(200);
    const after = streams(await t.get('/v1/streams/series/tt0903747:1:1?sort=rank'));
    expect(after.candidates.map((c) => c.score)).toEqual(before.map((s) => s - 500));
  });

  it('reports a timing-out addon and still returns the others', async () => {
    const t = await setup();
    const slow = await t.install({ fixture: 'torrentio-rd', latencyMs: 2_000 });
    const good = await t.install({ fixture: 'torrentio-public' });
    const started = performance.now();
    const list = streams(await t.get('/v1/streams/movie/tt1375666'));
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(list.addons.map((a) => [a.addonId, a.status, a.errorCode, a.count])).toEqual([
      [slow.record.id, 'timeout', 'timeout', 0],
      [good.record.id, 'ok', undefined, 20],
    ]);
    expect(list.candidates).toHaveLength(20);
  });

  it('counts invalid streams as dropped', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'torrentio-public', mode: 'malformed' });
    const list = streams(await t.get('/v1/streams/movie/tt1375666'));
    expect(list.addons).toEqual([
      { addonId: record.id, addonName: 'Torrentio', status: 'ok', count: 20, dropped: 2 },
    ]);
  });

  it('keeps the raw streams in the store and never returns them', async () => {
    const t = await setup();
    const rd = await t.install({ fixture: 'torrentio-rd' });
    const easynews = await t.install({ fixture: 'easynews' });
    const res = await t.get('/v1/streams/movie/tt1375666');
    expect(res.status).toBe(200);
    const list = streams(res);
    expect(list.candidates.length).toBeGreaterThan(0);

    // No stream URL (the fixtures' are all example.invalid), no `url` field, no secret.
    expect(res.text).not.toContain('example.invalid');
    expect(res.text).not.toMatch(/"(url|externalUrl|ytId|infoHash)"/);
    expect(res.text).not.toContain(SECRET);

    for (const candidate of list.candidates) {
      const stored = t.streams.get(candidate.key);
      expect(stored, candidate.key).toBeDefined();
      expect(stored?.addonId).toBe(candidate.addonId);
      expect(stored).toMatchObject({ type: 'movie', videoId: 'tt1375666' });
    }
    const first = list.candidates.find((c) => c.addonId === easynews.record.id);
    expect(t.streams.get(first?.key ?? '')?.stream).toMatchObject({
      url: expect.stringMatching(/^https:\/\/example\.invalid\//) as unknown,
    });
    expect(list.candidates.some((c) => c.addonId === rd.record.id)).toBe(true);
    expect(t.log.text()).not.toContain('example.invalid');
    expect(t.log.text()).not.toContain(SECRET);
  });

  it('derives the YouTube stream from a channel video id, like Stremio', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public' });
    const youtube = await t.install({ fixture: 'youtube' });
    const videoId = 'yt_id:UCq-Fj5jknLsUf-MWSy4_brA:b9V_q3Wvo8U';
    const list = streams(await t.get(`/v1/streams/channel/${encodeURIComponent(videoId)}`));
    expect(list.addons).toEqual([
      { addonId: youtube.record.id, addonName: 'YouTube', status: 'ok', count: 1, dropped: 0 },
    ]);
    expect(list.candidates).toHaveLength(1);
    const [candidate] = list.candidates;
    expect(candidate).toMatchObject({
      addonId: youtube.record.id,
      addonName: 'YouTube',
      kind: 'youtube',
      playable: true,
      playableWhen: 'live',
    });
    expect(t.streams.get(candidate?.key ?? '')?.stream).toMatchObject({ ytId: 'b9V_q3Wvo8U' });
    // Nobody was asked for streams (the YouTube addon serves catalog and meta only);
    // its meta was, for streams it carries.
    expect(youtube.fake.resourceRequests()).toEqual([
      '/meta/channel/yt_id:UCq-Fj5jknLsUf-MWSy4_brA.json',
    ]);

    // A bare channel id is not a video.
    const channel = streams(await t.get('/v1/streams/channel/yt_id:UCq-Fj5jknLsUf-MWSy4_brA'));
    expect(channel).toMatchObject({ candidates: [], addons: [] });
  });

  it('keeps real streams for a YouTube id next to the derived one, in collection order', async () => {
    const t = await setup();
    const videoId = 'yt_id:UCq-Fj5jknLsUf-MWSy4_brA:b9V_q3Wvo8U';
    const extra = await t.install({
      fixture: 'torrentio-public',
      manifest: {
        id: 'test.yt-streams',
        name: 'YT Streams',
        resources: ['stream'],
        types: ['channel'],
        idPrefixes: ['yt_id:'],
        catalogs: [],
      },
      routes: {
        [`stream/channel/${videoId}`]: {
          streams: [{ name: 'Mirror', url: 'https://example.invalid/redacted/yt' }],
        },
      },
    });
    const youtube = await t.install({ fixture: 'youtube' });
    const res = await t.get(`/v1/streams/channel/${videoId}`);
    const list = streams(res);
    expect(list.addons.map((a) => [a.addonId, a.status, a.count])).toEqual([
      [extra.record.id, 'ok', 1],
      [youtube.record.id, 'ok', 1],
    ]);
    expect(list.candidates.map((c) => [c.addonId, c.kind])).toEqual([
      // URL streams for `channel` are live (toCandidate's rule).
      [extra.record.id, 'live'],
      [youtube.record.id, 'youtube'],
    ]);
    expect(res.text).not.toContain('example.invalid');
  });

  it('logs only the route pattern and counts', async () => {
    const t = await setup();
    await t.install({ fixture: 'torrentio-public' });
    await t.get('/v1/streams/series/tt0903747:1:1');
    const line = t.log.lines().find((l) => l.msg === 'browse result');
    expect(line).toMatchObject({
      route: '/v1/streams/{type}/{videoId}',
      addons: 1,
      items: 20,
      notOk: 0,
    });
    expect(t.log.text()).not.toContain('tt0903747');
  });
});

describe('GET /v1/subtitles', () => {
  const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> there\r\n\r\n';
  const ASS = [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:03.00,0:00:04.50,Default,,0,0,0,,{\\an8}Top, line\\Nsecond',
  ].join('\n');

  async function subtitlesSetup(options: { subtitleMaxBytes?: number } = {}) {
    const t = await setup(options);
    const subs = await t.install({
      fixture: 'cinemeta',
      manifest: SUBTITLES_MANIFEST,
      subtitleFiles: {
        'eng.srt': { lang: 'eng', label: 'English', body: SRT },
        'ita.ass': { lang: 'ita', body: ASS, contentType: 'text/x-ssa' },
      },
    });
    return { ...t, subs };
  }

  it('lists tracks with Multitap paths, not the original URLs', async () => {
    const t = await subtitlesSetup();
    const res = await t.get('/v1/subtitles/movie/tt1375666');
    expect(res.status).toBe(200);
    const list = SubtitleListSchema.parse(res.json());
    expect(list.addons).toEqual([
      {
        addonId: t.subs.record.id,
        addonName: 'Fake Subtitles',
        status: 'ok',
        count: 2,
        dropped: 0,
      },
    ]);
    expect(list.subtitles.map((s) => [s.lang, s.label, s.addonId])).toEqual([
      ['eng', 'English', t.subs.record.id],
      ['ita', undefined, t.subs.record.id],
    ]);
    for (const track of list.subtitles) {
      expect(track.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(track.url).toBe(`/v1/subtitles/file/${track.id}.vtt`);
    }
    expect(res.text).not.toContain(t.subs.fake.origin);
    expect(res.text).not.toContain(SECRET);
  });

  it('serves the files as WebVTT, converted and cached', async () => {
    const t = await subtitlesSetup();
    const list = SubtitleListSchema.parse((await t.get('/v1/subtitles/movie/tt1375666')).json());
    const [srt, ass] = list.subtitles;
    const srtRes = await t.get(srt?.url ?? '');
    expect(srtRes.status).toBe(200);
    expect(srtRes.type).toBe('text/vtt; charset=utf-8');
    expect(srtRes.text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>Hello</i> there\n');
    const assRes = await t.get(ass?.url ?? '');
    expect(assRes.text).toBe('WEBVTT\n\n00:00:03.000 --> 00:00:04.500\nTop, line\nsecond\n');

    // A second read comes from the cache.
    await t.get(srt?.url ?? '');
    const fetched = t.subs.fake.requests.filter((path) => path.startsWith('/subs/'));
    expect(fetched).toEqual(['/subs/eng.srt', '/subs/ita.ass']);
    expect(t.log.text()).not.toContain(SECRET);
  });

  it('is a 404 for an unknown file id and a 400 for a malformed one', async () => {
    const t = await subtitlesSetup();
    const res = await t.get(`/v1/subtitles/file/${'A'.repeat(32)}.vtt`);
    expect(res.status).toBe(404);
    expect(res.type).toBe(PROBLEM_CONTENT_TYPE);
    expect((await t.get('/v1/subtitles/file/short.vtt')).status).toBe(400);
  });

  it('is a 502 for a file over the size cap, a failing server or an unreadable file', async () => {
    const t = await subtitlesSetup({ subtitleMaxBytes: 1024 });
    t.subs.fake.set({
      subtitleFiles: {
        'big.srt': { lang: 'eng', body: SRT.repeat(200) },
        'gone.srt': { lang: 'eng', body: '' },
        'junk.srt': { lang: 'eng', body: '<html>not subtitles</html>' },
      },
    });
    const list = SubtitleListSchema.parse((await t.get('/v1/subtitles/movie/tt1375666')).json());
    const [big, gone, junk] = list.subtitles;
    const tooBig = await t.get(big?.url ?? '');
    expect(tooBig.status).toBe(502);
    expect((tooBig.json() as { detail: string }).detail).toMatch(/larger than 1024 bytes/);

    t.subs.fake.set({ subtitleFiles: { 'junk.srt': { lang: 'eng', body: '<html></html>' } } });
    const missing = await t.get(gone?.url ?? '');
    expect(missing.status).toBe(502);
    expect((missing.json() as { detail: string }).detail).toMatch(/HTTP 404/);
    const unreadable = await t.get(junk?.url ?? '');
    expect(unreadable.status).toBe(502);
    expect((unreadable.json() as { detail: string }).detail).toMatch(/no supported format/);
    expect(t.bodies.join('\n')).not.toContain(t.subs.fake.origin);
  });
});

describe('browse routes in the OpenAPI document', () => {
  it('declares every route with named schemas and problem responses', () => {
    const doc = openApiDocument();
    const paths = doc.paths ?? {};
    const routes = [
      '/v1/catalogs',
      '/v1/catalog/{addonId}/{type}/{id}',
      '/v1/meta/{type}/{id}',
      '/v1/streams/{type}/{videoId}',
      '/v1/subtitles/{type}/{videoId}',
      '/v1/subtitles/file/{file}',
    ];
    for (const route of routes) {
      const op = paths[route]?.get;
      expect(op, route).toBeDefined();
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404']));
      if (route !== '/v1/catalogs') {
        expect(op?.responses?.['400']).toMatchObject({
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        });
      }
    }
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'CatalogRef',
      'CatalogPage',
      'MetaPreview',
      'MetaDetail',
      'MetaResult',
      'MetaVideo',
      'SourceList',
      'SourceCandidate',
      'ParsedSource',
      'AddonStatus',
      'SubtitleList',
      'SubtitleTrack',
    ]) {
      expect(schemas, name).toHaveProperty(name);
    }
    const streams = paths['/v1/streams/{type}/{videoId}']?.get;
    expect(streams?.parameters?.map((p) => ('name' in p ? p.name : ''))).toEqual([
      'type',
      'videoId',
      'engine',
      'highRes',
      'sort',
      'incremental',
      'explain',
      'preferredLanguage',
      'preferBingeGroup',
      'profileId',
    ]);
    expect(paths['/v1/subtitles/file/{file}']?.get?.responses?.['200']).toMatchObject({
      content: { 'text/vtt': { schema: { type: 'string' } } },
    });
  });
});
