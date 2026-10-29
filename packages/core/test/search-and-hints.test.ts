/**
 * `GET /v1/search` (gap item 5) and the subtitle request extras `videoHash`,
 * `videoSize` and `filename` (gap item 6): the query on `/v1/subtitles/…` and
 * the hint resolution of `/v1/sessions/{id}/subtitles` (stream hints, else the
 * engine's `/opensubHash`).
 */
import { SearchResultSchema, SessionSubtitleListSchema, SubtitleListSchema } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/auth/keys.ts';
import { createApp, openApiDocument } from '../src/http/app.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { AddonService } from '../src/addons/index.ts';
import { loadConfig } from '../src/config.ts';
import { addHomeEngine } from './engine-fixture.ts';
import { PROBLEM_CONTENT_TYPE } from '../src/http/problem.ts';
import {
  SAMPLE_SUBTITLE_FILES,
  startFakeAddon,
  SUBTITLES_MANIFEST,
  type FakeAddon,
  type FakeAddonOptions,
} from './fakes/addon.ts';
import { fakeOpenSubHash } from './fakes/engine.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';
import type { Stream } from '@multitap/addon-protocol';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const fakes: FakeAddon[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});

async function setup() {
  const db = await migratedMemoryDb();
  await addHomeEngine(db);
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '400',
    MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS: '400',
  });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams: new StreamStore({ clock }),
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics: new MetricsRegistry(),
  });
  const key = (await createApiKey(db, { scope: 'client', label: 'client' }, clock)).key;
  const get = async (path: string) => {
    const res = await app.request(path, { headers: bearer(key) });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get('Content-Type'),
      json: () => JSON.parse(text) as unknown,
    };
  };
  const install = async (opts: FakeAddonOptions) => {
    const fake = await startFakeAddon(opts);
    fakes.push(fake);
    return { fake, record: await addons.collection.add(fake.manifestUrl) };
  };
  return { addons, get, install };
}

const hinted = (name: string, behaviorHints: Record<string, unknown>) =>
  ({ ...httpStream(name), behaviorHints }) as Stream;

const meta = (id: string, name: string, type = 'movie') => ({
  metas: [{ id, type, name, poster: 'https://img.example/p.jpg' }],
});

describe('GET /v1/search', () => {
  it('searches every catalog with a search extra, grouped per catalog in collection order', async () => {
    const t = await setup();
    const cinemeta = await t.install({
      fixture: 'cinemeta',
      routes: { 'catalog/series/top/search=dune': meta('tt0142032', 'Dune', 'series') },
    });

    const res = await t.get('/v1/search?q=dune');
    expect(res.status).toBe(200);
    const result = SearchResultSchema.parse(res.json());
    expect(result).toMatchObject({ query: 'dune', skip: 0 });
    expect(result.sources.map((s) => [s.addonId, s.type, s.catalogId, s.catalogName])).toEqual([
      [cinemeta.record.id, 'movie', 'top', 'Popular'],
      [cinemeta.record.id, 'series', 'top', 'Popular'],
    ]);
    const [movies, series] = result.sources;
    expect(movies?.metas.length).toBeGreaterThan(0);
    expect(movies?.addon).toMatchObject({ status: 'ok', addonName: 'Cinemeta' });
    expect(movies?.addon.count).toBe(movies?.metas.length);
    expect(series?.metas.map((m) => m.name)).toEqual(['Dune']);
    // Catalogs without `search` (year, imdbRating, …) are not asked.
    expect(cinemeta.fake.resourceRequests().sort()).toEqual([
      '/catalog/movie/top/search=dune.json',
      '/catalog/series/top/search=dune.json',
    ]);
  });

  it('filters by type and types', async () => {
    const t = await setup();
    const { fake } = await t.install({ fixture: 'cinemeta' });
    const movie = SearchResultSchema.parse((await t.get('/v1/search?q=dune&type=movie')).json());
    expect(movie.sources.map((s) => s.type)).toEqual(['movie']);
    const none = SearchResultSchema.parse((await t.get('/v1/search?q=dune&types=anime,tv')).json());
    expect(none.sources).toEqual([]);
    expect(fake.resourceRequests()).toEqual(['/catalog/movie/top/search=dune.json']);
  });

  it('pages with skip, only through catalogs that declare skip', async () => {
    const t = await setup();
    const { fake } = await t.install({
      fixture: 'cinemeta',
      routes: {
        'catalog/movie/top/search=dune&skip=100': meta('tt0000100', 'Dune Page Two'),
        'catalog/series/top/search=dune&skip=100': meta('tt0000101', 'Dune Series Two', 'series'),
      },
    });
    // A catalog that searches but cannot page.
    const plain = await t.install({
      fixture: 'youtube',
      manifest: {
        id: 'dev.multitap.fake-plain-search',
        name: 'Plain search',
        catalogs: [{ type: 'channel', id: 'find', extra: [{ name: 'search' }] }],
      },
      routes: { 'catalog/channel/find/search=dune': { metas: [] } },
    });

    const first = SearchResultSchema.parse((await t.get('/v1/search?q=dune')).json());
    expect(first.sources.map((s) => s.addonName)).toEqual(['Cinemeta', 'Cinemeta', 'Plain search']);

    const second = SearchResultSchema.parse((await t.get('/v1/search?q=dune&skip=100')).json());
    expect(second.skip).toBe(100);
    expect(second.sources.map((s) => [s.addonName, s.skip, s.metas[0]?.name])).toEqual([
      ['Cinemeta', 100, 'Dune Page Two'],
      ['Cinemeta', 100, 'Dune Series Two'],
    ]);
    expect(fake.resourceRequests()).toContain('/catalog/movie/top/search=dune&skip=100.json');
    expect(plain.fake.resourceRequests()).toEqual(['/catalog/channel/find/search=dune.json']);
  });

  it('reports a failing addon without failing the search, and does not search catalogs needing other extras', async () => {
    const t = await setup();
    const good = await t.install({ fixture: 'cinemeta' });
    const bad = await t.install({
      fixture: 'youtube',
      manifest: {
        id: 'dev.multitap.fake-broken',
        name: 'Broken',
        catalogs: [
          { type: 'channel', id: 'top', extra: [{ name: 'search' }] },
          // Needs a genre as well: Stremio doesn't search it.
          {
            type: 'channel',
            id: 'genres',
            extra: [{ name: 'search' }, { name: 'genre', isRequired: true }],
          },
        ],
      },
      mode: 'error',
    });

    const res = await t.get('/v1/search?q=dune');
    expect(res.status).toBe(200);
    const result = SearchResultSchema.parse(res.json());
    const failed = result.sources.filter((s) => s.addonId === bad.record.id);
    expect(failed.map((s) => [s.catalogId, s.metas.length, s.addon.status])).toEqual([
      ['top', 0, 'error'],
    ]);
    expect(failed[0]?.addon.errorCode).toBeDefined();
    expect(result.sources.filter((s) => s.addonId === good.record.id)).toHaveLength(2);
    expect(bad.fake.resourceRequests()).toEqual(['/catalog/channel/top/search=dune.json']);
  });

  it('is empty without installed addons, and rejects a bad query', async () => {
    const t = await setup();
    const none = SearchResultSchema.parse((await t.get('/v1/search?q=dune')).json());
    expect(none.sources).toEqual([]);
    for (const path of ['/v1/search', '/v1/search?q=', '/v1/search?q=a&skip=x']) {
      const res = await t.get(path);
      expect(res.status, path).toBe(400);
      expect(res.type).toBe(PROBLEM_CONTENT_TYPE);
    }
  });

  it('is declared in the OpenAPI document', () => {
    const operation = (
      openApiDocument() as { paths: Record<string, { get?: { operationId?: string } }> }
    ).paths['/v1/search']?.get;
    expect(operation?.operationId).toBe('search');
  });
});

describe('GET /v1/subtitles with file hints', () => {
  it('sends videoHash, videoSize and filename as extras when given', async () => {
    const t = await setup();
    const subs = await t.install({
      fixture: 'cinemeta',
      manifest: SUBTITLES_MANIFEST,
      subtitleFiles: SAMPLE_SUBTITLE_FILES,
    });
    const hash = '8e245d9679d31e12';
    const res = await t.get(
      `/v1/subtitles/movie/tt1375666?videoHash=${hash}&videoSize=1503238553&filename=${encodeURIComponent('Inception 2010.mkv')}`,
    );
    expect(res.status).toBe(200);
    expect(SubtitleListSchema.parse(res.json()).subtitles.length).toBeGreaterThan(0);
    expect(subs.fake.resourceRequests()).toEqual([
      `/subtitles/movie/tt1375666/videoHash=${hash}&videoSize=1503238553&filename=Inception 2010.mkv.json`,
    ]);
    // Without hints nothing is added.
    await t.get('/v1/subtitles/movie/tt1375666');
    expect(subs.fake.resourceRequests().at(-1)).toBe('/subtitles/movie/tt1375666.json');

    for (const bad of ['videoHash=XYZ', 'videoSize=big', 'filename=']) {
      expect((await t.get(`/v1/subtitles/movie/tt1375666?${bad}`)).status, bad).toBe(400);
    }
  });
});

describe('GET /v1/sessions/{id}/subtitles hints', () => {
  async function sessionSetup(options: Parameters<typeof sessionRig>[0] = {}) {
    const r = await sessionRig(options);
    rigs.push(r);
    const fake = await startFakeAddon({
      fixture: 'cinemeta',
      manifest: SUBTITLES_MANIFEST,
      subtitleFiles: SAMPLE_SUBTITLE_FILES,
    });
    fakes.push(fake);
    await r.addons.collection.add(fake.manifestUrl);
    const key = await r.keyFor('client');
    const listSubs = async (id: string) => {
      const res = await r.app.request(`/v1/sessions/${id}/subtitles`, { headers: bearer(key) });
      expect(res.status).toBe(200);
      return SessionSubtitleListSchema.parse(await res.json());
    };
    const create = async (stream: Stream, name: string) => {
      const res = await r.app.request('/v1/sessions', {
        method: 'POST',
        headers: { ...bearer(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: name, item: MOVIE, source: { key: r.list(stream) } }),
      });
      const { id } = (await res.json()) as { id: string };
      await r.settle();
      return id;
    };
    return { r, fake, listSubs, create };
  }

  it("asks the engine for the source's hash, once per session", async () => {
    const t = await sessionSetup();
    const stream = httpStream('good');
    const id = await t.create(hinted('good', { filename: 'Good.Movie.2026.mkv' }), 'a');
    const expected = fakeOpenSubHash(stream.url as string);

    const list = await t.listSubs(id);
    expect(list.subtitles.length).toBeGreaterThan(0);
    expect(t.fake.resourceRequests()).toEqual([
      `/subtitles/movie/tt0000001/videoHash=${expected.hash}&videoSize=${String(expected.size)}&filename=Good.Movie.2026.mkv.json`,
    ]);
    expect(t.r.fake.openSubHashRequests).toEqual([stream.url]);

    await t.listSubs(id);
    expect(t.r.fake.openSubHashRequests).toHaveLength(1);
    // The URL is the engine's business only: it is in no log line.
    expect(t.r.log.text()).not.toContain('media.example');
  });

  it("uses the stream's own hints without asking the engine", async () => {
    const t = await sessionSetup();
    const id = await t.create(
      hinted('hinted', { videoHash: '0123456789abcdef', videoSize: 42, filename: 'h.mkv' }),
      'b',
    );
    await t.listSubs(id);
    expect(t.fake.resourceRequests()).toEqual([
      '/subtitles/movie/tt0000001/videoHash=0123456789abcdef&videoSize=42&filename=h.mkv.json',
    ]);
    expect(t.r.fake.openSubHashRequests).toEqual([]);
  });

  it('falls back silently to the stream hints on an engine without /opensubHash', async () => {
    const t = await sessionSetup({ fake: { supportsOpenSubHash: false } });
    const id = await t.create(hinted('old', { filename: 'Old.mkv' }), 'c');
    await t.listSubs(id);
    await t.listSubs(id);
    expect(t.fake.resourceRequests()).toEqual([
      '/subtitles/movie/tt0000001/filename=Old.mkv.json',
      '/subtitles/movie/tt0000001/filename=Old.mkv.json',
    ]);
    // The engine was asked once only, then remembered as lacking the endpoint.
    expect(t.r.fake.requests.filter((q) => q.path === '/opensubHash')).toHaveLength(1);
  });

  it('does not wait for a failing or slow hash read', async () => {
    const t = await sessionSetup();
    const stream = httpStream('broken');
    const id = await t.create(stream, 'd');
    t.r.fake.failOpenSubHashFor.add(stream.url as string);
    const list = await t.listSubs(id);
    expect(list.subtitles.length).toBeGreaterThan(0);
    expect(t.fake.resourceRequests()).toEqual(['/subtitles/movie/tt0000001.json']);
    // A failed lookup is not retried at once.
    await t.listSubs(id);
    expect(t.r.fake.openSubHashRequests).toHaveLength(1);
  });
});
