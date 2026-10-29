/**
 * Review PoC (parity): places where Multitap drops or cannot serve something
 * Stremio's official clients use. Each gap has a passing test pinning what
 * Multitap does today and an `it.fails` test with what a Stremio-compatible
 * client would expect, so the suite stays green.
 */
import {
  CatalogPageSchema,
  LibraryItemSchema,
  ProfileSchema,
  SourceListSchema,
  SubtitleListSchema,
  type MetaDetail,
} from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../../../src/addons/index.ts';
import { createApiKey } from '../../../src/auth/keys.ts';
import { loadConfig } from '../../../src/config.ts';
import { addHomeEngine } from '../../engine-fixture.ts';
import { createApp } from '../../../src/http/app.ts';
import { sequentialIds } from '../../../src/lib/ids.ts';
import { LibraryService } from '../../../src/library/service.ts';
import { MetricsRegistry } from '../../../src/metrics/index.ts';
import { StreamStore } from '../../../src/selection/stream-store.ts';
import { SubtitleService } from '../../../src/subtitles/index.ts';
import { startFakeAddon, type FakeAddon, type FakeAddonOptions } from '../../fakes/addon.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from '../../helpers.ts';

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const SERIES: MetaDetail = {
  id: 'tt0903747',
  type: 'series',
  name: 'Breaking Bad',
  posterShape: 'poster',
  genres: [],
  links: [],
  trailers: [],
  behaviorHints: { isLive: false, hasScheduledVideos: false },
  videos: [1, 2, 3].map((episode) => ({
    id: `tt0903747:1:${String(episode)}`,
    title: `Episode ${String(episode)}`,
    season: 1,
    episode,
  })),
};

async function setup() {
  const db = await migratedMemoryDb();
  await addHomeEngine(db);
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: 'test' });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const library = new LibraryService({
    db,
    clock,
    logger: log.logger,
    meta: (type, id) =>
      Promise.resolve(type === SERIES.type && id === SERIES.id ? SERIES : undefined),
    ids: sequentialIds(),
  });
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams: new StreamStore({ clock }),
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics: new MetricsRegistry(),
    library,
  });
  const key = (await createApiKey(db, { scope: 'client', label: 'client' }, clock)).key;
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { ...bearer(key) };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as unknown };
  };
  const install = async (opts: FakeAddonOptions) => {
    const fake = await startFakeAddon(opts);
    fakes.push(fake);
    return { fake, record: await addons.collection.add(fake.manifestUrl) };
  };
  return { call, install };
}

// ---- 1. Notification and calendar catalogs answer `metasDetailed` ----------------

/** What Cinemeta answers on `catalog/series/last-videos/lastVideosIds=…` (shape only). */
const METAS_DETAILED = {
  metasDetailed: [
    {
      ...SERIES,
      videos: SERIES.videos.map((v) => ({ ...v, released: '2008-01-20T00:00:00.000Z' })),
    },
  ],
};
const LAST_VIDEOS_ROUTE = 'catalog/series/last-videos/lastVideosIds=tt0903747';

describe('metasDetailed catalogs (Cinemeta last-videos / calendar-videos)', () => {
  it('current: the catalog is listed but every page fails with unexpected-response', async () => {
    const t = await setup();
    const { record } = await t.install({
      fixture: 'cinemeta',
      routes: { [LAST_VIDEOS_ROUTE]: METAS_DETAILED },
    });
    const catalogs = (await t.call('GET', '/v1/catalogs')).json() as { id: string }[];
    expect(catalogs.map((c) => c.id)).toContain('last-videos');
    const res = await t.call(
      'GET',
      `/v1/catalog/${record.id}/series/last-videos?lastVideosIds=tt0903747`,
    );
    expect(res.status).toBe(200);
    const page = CatalogPageSchema.parse(res.json());
    expect(page.metas).toEqual([]);
    expect(page.addon.status).toBe('error');
    expect(page.addon.errorCode).toBe('unexpected-response');
  });

  it.fails('expected: the page returns the detailed metas', async () => {
    const t = await setup();
    const { record } = await t.install({
      fixture: 'cinemeta',
      routes: { [LAST_VIDEOS_ROUTE]: METAS_DETAILED },
    });
    const res = await t.call(
      'GET',
      `/v1/catalog/${record.id}/series/last-videos?lastVideosIds=tt0903747`,
    );
    const page = CatalogPageSchema.parse(res.json());
    expect(page.addon.status).toBe('ok');
    expect(page.metas.map((m) => m.id)).toEqual(['tt0903747']);
  });

  it('current: an Ids extra longer than 500 characters is refused (Stremio sends up to 100 ids in one value)', async () => {
    const t = await setup();
    const { record } = await t.install({ fixture: 'cinemeta' });
    const ids = Array.from({ length: 100 }, (_, i) => `tt${String(1_000_000 + i)}`).join(',');
    expect(ids.length).toBeGreaterThan(500);
    const res = await t.call(
      'GET',
      `/v1/catalog/${record.id}/series/last-videos?lastVideosIds=${ids}`,
    );
    expect(res.status).toBe(400);
  });
});

// ---- 2. A stream's own subtitles and 3. externalUrl streams ------------------------

const STREAMS = {
  streams: [
    {
      name: 'HTTP 1080p',
      title: 'With its own subtitles',
      url: 'http://127.0.0.1:9/movie.mkv',
      subtitles: [{ id: 'own-1', lang: 'xyz', url: 'http://127.0.0.1:9/movie.xyz.srt' }],
    },
    { name: 'Watch on a service', externalUrl: 'https://example.com/watch/inception-123' },
  ],
};

describe('stream fields Stremio clients use', () => {
  const install = async () => {
    const t = await setup();
    await t.install({
      fixture: 'torrentio-public',
      routes: { 'stream/movie/tt1375666': STREAMS },
    });
    return t;
  };

  it('current: stream.subtitles reach neither the source list nor the subtitle list', async () => {
    const t = await install();
    const list = await t.call('GET', '/v1/streams/movie/tt1375666');
    expect(list.status).toBe(200);
    const sources = SourceListSchema.parse(list.json());
    expect(sources.candidates).toHaveLength(2);
    expect(list.text).not.toContain('xyz');
    const subs = await t.call('GET', '/v1/subtitles/movie/tt1375666');
    expect(SubtitleListSchema.parse(subs.json()).subtitles).toEqual([]);
  });

  it.fails('expected: the stream subtitle is offered for that stream', async () => {
    const t = await install();
    const list = await t.call('GET', '/v1/streams/movie/tt1375666');
    expect(list.text).toContain('xyz');
  });

  it('current: an externalUrl stream is listed as unplayable with no way to open it', async () => {
    const t = await install();
    const sources = SourceListSchema.parse(
      (await t.call('GET', '/v1/streams/movie/tt1375666')).json(),
    );
    const external = sources.candidates.find((c) => c.kind === 'external');
    expect(external).toMatchObject({ playable: false, unplayableReason: 'external' });
    expect(JSON.stringify(sources)).not.toContain('example.com');
  });

  it.fails('expected: the externalUrl is given to the client to open', async () => {
    const t = await install();
    const list = await t.call('GET', '/v1/streams/movie/tt1375666');
    expect(list.text).toContain('https://example.com/watch/inception-123');
  });
});

// ---- 4. Per-video watched state -------------------------------------------------

describe('which episodes are watched', () => {
  it('current: only the whole library and an opaque zlib bitfield are available', async () => {
    const t = await setup();
    const profile = ProfileSchema.parse(
      (await t.call('POST', '/v1/profiles', { name: 'p' })).json(),
    );
    const lib = `/v1/profiles/${profile.id}/library/series/tt0903747`;
    expect((await t.call('PUT', lib)).status).toBe(200);
    const marked = await t.call('POST', `${lib}/videos/tt0903747:1:2/watched`, { watched: true });
    expect(marked.status).toBe(200);
    const item = LibraryItemSchema.parse(marked.json());
    // `{anchorVideoId}:{anchorLength}:{base64(zlib(bits))}`: a client has to
    // port stremio-core's WatchedBitField (and its video sort) to read it.
    expect(item.state.watched).toMatch(/^tt0903747:1:2:2:[A-Za-z0-9+/=]+$/);
    // No route reads one library item.
    expect([404, 405]).toContain((await t.call('GET', lib)).status);
  });

  it.fails('expected: one item can be read with a watched flag per video', async () => {
    const t = await setup();
    const profile = ProfileSchema.parse(
      (await t.call('POST', '/v1/profiles', { name: 'p' })).json(),
    );
    const lib = `/v1/profiles/${profile.id}/library/series/tt0903747`;
    await t.call('PUT', lib);
    await t.call('POST', `${lib}/videos/tt0903747:1:2/watched`, { watched: true });
    const res = await t.call('GET', lib);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/tt0903747:1:2/);
  });
});

// ---- 5. Live sources --------------------------------------------------------------

describe('live TV sources', () => {
  it('current: a tv stream is ranked playable, though sessions refuse live sources (engine-module.ts, fail live)', async () => {
    const t = await setup();
    await t.install({
      fixture: 'torrentio-public',
      manifest: { types: ['tv'], resources: ['stream'], idPrefixes: ['live:'] },
      routes: {
        'stream/tv/live:news1': {
          streams: [{ name: 'News', url: 'http://127.0.0.1:9/live/news1/index.m3u8' }],
        },
      },
    });
    const list = SourceListSchema.parse((await t.call('GET', '/v1/streams/tv/live:news1')).json());
    expect(list.candidates[0]).toMatchObject({ kind: 'live', playable: true });
  });
});
