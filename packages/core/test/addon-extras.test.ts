/**
 * Streams embedded in a meta, manifest hints and `configurationRequired`, the
 * addon User-Agent, default addons and the manifest preview (gap items 7, 8, 10).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddonSchema, SourceListSchema } from '@multitap/api';
import { fetchManifest } from '@multitap/addon-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { addHomeEngine } from './engine-fixture.ts';
import { createApp } from '../src/http/app.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import {
  FIXTURES_DIR,
  startFakeAddon,
  type FakeAddon,
  type FakeAddonOptions,
} from './fakes/addon.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

const SECRET = 'sk-SECRET-DEBRID-KEY-8c1f';

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setup(env: Record<string, string> = {}) {
  const db = await migratedMemoryDb();
  await addHomeEngine(db);
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const streams = new StreamStore({ clock });
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams,
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics: new MetricsRegistry(),
  });
  const admin = (await createApiKey(db, { scope: 'admin', label: 'a' }, clock)).key;
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: bearer(admin) };
    if (body !== undefined) {
      init.headers = { ...bearer(admin), 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as unknown };
  };
  const install = async (opts: FakeAddonOptions) => {
    const fake = await startFakeAddon({ prefix: `/${SECRET}`, ...opts });
    fakes.push(fake);
    return { fake, record: await addons.collection.add(fake.manifestUrl) };
  };
  return { db, log, config, addons, streams, call, install };
}

const fixtureMeta = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, 'cinemeta', `${name}.json`), 'utf8')) as {
    meta: Record<string, unknown> & { videos: Record<string, unknown>[] };
  };

const sources = (res: { json: () => unknown }) => SourceListSchema.parse(res.json());

describe('streams embedded in meta', () => {
  it("lists a video's embedded streams as candidates of the meta addon, deduplicated", async () => {
    const t = await setup();
    const { meta } = fixtureMeta('meta-series-tt0903747');
    const inline = { url: 'https://example.invalid/redacted/inline.mkv', name: 'Inline' };
    meta.videos = meta.videos.map((video) =>
      video.id === 'tt0903747:1:1'
        ? {
            ...video,
            streams: [inline, inline, { ytId: 'dQw4w9WgXcQ' }],
            // Trailers are not sources.
            trailerStreams: [{ ytId: 'YoHD9XEInc0' }],
          }
        : video,
    );
    const cinemeta = await t.install({
      fixture: 'cinemeta',
      routes: { 'meta/series/tt0903747': { meta } },
    });
    const torrentio = await t.install({ fixture: 'torrentio-public' });

    const res = await t.call('GET', '/v1/streams/series/tt0903747:1:1');
    expect(res.status).toBe(200);
    const list = sources(res);
    const own = list.candidates.filter((c) => c.addonId === cinemeta.record.id);
    expect(own.map((c) => c.kind)).toEqual(['http', 'youtube']);
    expect(list.candidates.some((c) => c.addonId === torrentio.record.id)).toBe(true);
    expect(list.addons.map((a) => [a.addonId, a.status])).toEqual([
      [cinemeta.record.id, 'ok'],
      [torrentio.record.id, 'ok'],
    ]);
    expect(list.addons[0]?.count).toBe(2);
    const stored = t.streams.get(own[0]?.key ?? '');
    expect(stored).toMatchObject({ addonId: cinemeta.record.id, videoId: 'tt0903747:1:1' });
    expect(stored?.stream).toMatchObject({ url: inline.url });
    expect(res.text).not.toContain('example.invalid');
    expect(res.text).not.toContain('YoHD9XEInc0');

    // Another episode has no embedded streams: no part for the meta addon.
    const other = sources(await t.call('GET', '/v1/streams/series/tt0903747:1:2'));
    expect(other.addons.map((a) => a.addonId)).toEqual([torrentio.record.id]);
  });

  it("lists a movie's own streams", async () => {
    const t = await setup();
    const { meta } = fixtureMeta('meta-movie-tt1375666');
    const cinemeta = await t.install({
      fixture: 'cinemeta',
      routes: {
        'meta/movie/tt1375666': {
          meta: { ...meta, streams: [{ url: 'https://example.invalid/redacted/movie.mkv' }] },
        },
      },
    });
    const list = sources(await t.call('GET', '/v1/streams/movie/tt1375666'));
    expect(list.candidates.map((c) => [c.addonId, c.kind])).toEqual([[cinemeta.record.id, 'http']]);
  });
});

describe('manifest hints and configurationRequired', () => {
  const hints = { configurable: true, configurationRequired: true, adult: true, p2p: true };

  it('exposes the hints and flags an addon that needs configuring', async () => {
    const t = await setup();
    const torrentio = await t.install({
      fixture: 'torrentio-public',
      manifest: { behaviorHints: hints },
    });
    const plain = await t.install({ fixture: 'cinemeta' });
    const res = await t.call('GET', '/v1/admin/addons');
    const [first, second] = (res.json() as unknown[]).map((a) => AddonSchema.parse(a));
    expect(first).toMatchObject({
      behaviorHints: hints,
      state: 'needs-configuration',
      configurationUrl: `${torrentio.fake.origin}/configure`,
    });
    expect(second).toMatchObject({ id: plain.record.id, state: 'ready', configurationUrl: null });
    expect(second?.behaviorHints.configurationRequired).toBe(false);
    // Only the origin; the secret path stays secret.
    expect(res.text).not.toContain(SECRET);
  });

  it('skips it in aggregation with a clear status instead of failing every call', async () => {
    const t = await setup();
    const torrentio = await t.install({
      fixture: 'torrentio-public',
      manifest: { behaviorHints: { configurationRequired: true } },
    });
    const list = sources(await t.call('GET', '/v1/streams/series/tt0903747:1:1'));
    expect(list.candidates).toEqual([]);
    expect(list.addons).toEqual([
      {
        addonId: torrentio.record.id,
        addonName: expect.any(String) as unknown,
        status: 'needs-configuration',
        count: 0,
        dropped: 0,
      },
    ]);
    expect(torrentio.fake.resourceRequests()).toEqual([]);
  });
});

describe('User-Agent', () => {
  it('sends the configured agent on manifest and resource requests; default names Multitap', async () => {
    expect(loadConfig({ NODE_ENV: 'test' }).addons.userAgent).toMatch(
      /^Multitap\/\d\S* \(\+https:\/\/multitap\.dev\)$/,
    );
    const seen: (Record<string, string> | undefined)[] = [];
    const fake = await startFakeAddon({ fixture: 'torrentio-public' });
    fakes.push(fake);
    const service = new AddonService({
      config: loadConfig({ NODE_ENV: 'test', MULTITAP_ADDON_USER_AGENT: 'Test-Agent/1' }),
      db: await migratedMemoryDb(),
      logger: memoryLogger().logger,
      clock: manualClock(),
      fetchManifest: (url, options) => {
        seen.push(options.headers);
        return fetchManifest(url, options);
      },
      fetchResource: (_url, _path, options) => {
        seen.push(options.headers);
        return Promise.resolve({
          response: { type: 'streams', streams: [] },
          dropped: [],
        } as never);
      },
    });
    await service.collection.add(fake.manifestUrl);
    await service.aggregate('stream', 'series', 'tt0903747:1:1');
    expect(seen).toEqual([{ 'user-agent': 'Test-Agent/1' }, { 'user-agent': 'Test-Agent/1' }]);
  });
});

describe('default addons', () => {
  it('installs MULTITAP_DEFAULT_ADDONS only into an empty collection', async () => {
    const fake = await startFakeAddon({ fixture: 'cinemeta', prefix: `/${SECRET}` });
    fakes.push(fake);
    const t = await setup({
      MULTITAP_DEFAULT_ADDONS: ` ${fake.manifestUrl}, ,https://127.0.0.1:1/manifest.json`,
    });
    expect(t.config.addons.defaultManifestUrls).toHaveLength(2);
    await t.addons.seedDefaults();
    const installed = await t.addons.collection.list();
    expect(installed.map((r) => r.manifest.name)).toEqual(['Cinemeta']);
    // Not over addons the admin has.
    await t.addons.collection.remove(installed[0]?.id ?? '');
    await t.install({ fixture: 'youtube' });
    await t.addons.seedDefaults();
    expect((await t.addons.collection.list()).map((r) => r.manifest.name)).toEqual(['YouTube']);
    expect(t.log.text()).not.toContain(SECRET);
    expect(t.log.text()).not.toContain('127.0.0.1:1');
  });

  it('is empty by default', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).addons.defaultManifestUrls).toEqual([]);
  });
});

describe('POST /v1/admin/addons/preview', () => {
  it('returns the addon without storing or logging it', async () => {
    const t = await setup();
    const fake = await startFakeAddon({ fixture: 'cinemeta', prefix: `/${SECRET}` });
    fakes.push(fake);
    const res = await t.call('POST', '/v1/admin/addons/preview', { manifestUrl: fake.manifestUrl });
    expect(res.status).toBe(200);
    const addon = AddonSchema.parse(res.json());
    expect(addon).toMatchObject({ name: 'Cinemeta', id: '', enabled: true });
    expect(await t.addons.collection.list()).toEqual([]);
    expect(res.text).not.toContain(SECRET);
    expect(t.log.text()).not.toContain(SECRET);

    // Once installed, the preview carries the installed id.
    const added = await t.addons.collection.add(fake.manifestUrl);
    const again = AddonSchema.parse(
      (await t.call('POST', '/v1/admin/addons/preview', { manifestUrl: fake.manifestUrl })).json(),
    );
    expect(again.id).toBe(added.id);
  });

  it('refuses what an install refuses, naming no URL', async () => {
    const t = await setup();
    const legacy = await t.call('POST', '/v1/admin/addons/preview', {
      manifestUrl: `https://example.invalid/${SECRET}/stremio/v1`,
    });
    expect(legacy.status).toBe(400);
    const down = await t.call('POST', '/v1/admin/addons/preview', {
      manifestUrl: `http://127.0.0.1:1/${SECRET}/manifest.json`,
    });
    expect(down.status).toBe(400);
    expect(down.text).not.toContain(SECRET);
    expect(t.log.text()).not.toContain(SECRET);
  });
});
