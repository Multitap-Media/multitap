import { AddonSchema, type Addon } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/http/app.ts';
import { openApiDocument } from '../src/http/app.ts';
import { PROBLEM_CONTENT_TYPE } from '../src/http/problem.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { startFakeAddon, type FakeAddon, type FakeAddonOptions } from './fakes/addon.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

/** Stands in for a debrid key in a configured addon's URL. */
const SECRET = 'sk-SECRET-DEBRID-KEY-8c1f';

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fake(options: FakeAddonOptions): Promise<FakeAddon> {
  const addon = await startFakeAddon(options);
  fakes.push(addon);
  return addon;
}

async function setup() {
  const db = await migratedMemoryDb();
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: 'test' });
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
  const key = (await createApiKey(db, { scope: 'admin', label: 'admin' }, clock)).key;
  const bodies: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: bearer(key) };
    if (body !== undefined) {
      init.headers = { ...bearer(key), 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await app.request(path, init);
    const text = await res.text();
    bodies.push(text);
    return {
      status: res.status,
      type: res.headers.get('Content-Type'),
      json: () => JSON.parse(text) as unknown,
    };
  };
  const add = async (manifestUrl: string) => {
    const res = await call('POST', '/v1/admin/addons', { manifestUrl });
    expect(res.status).toBe(201);
    return AddonSchema.parse(res.json());
  };
  const list = async () => {
    const res = await call('GET', '/v1/admin/addons');
    expect(res.status).toBe(200);
    return (res.json() as unknown[]).map((item) => AddonSchema.parse(item));
  };
  return { db, log, clock, config, addons, app, key, call, add, list, bodies };
}

const detailOf = (res: { json: () => unknown }) => (res.json() as { detail?: string }).detail;

describe('/v1/admin/addons', () => {
  it('adds, lists, reorders, disables and removes addons', async () => {
    const t = await setup();
    const cinemeta = await fake({ fixture: 'cinemeta' });
    const torrentio = await fake({ fixture: 'torrentio-rd', prefix: `/${SECRET}` });

    const a = await t.add(cinemeta.manifestUrl);
    expect(a).toMatchObject({
      manifestId: 'com.linvo.cinemeta',
      name: 'Cinemeta',
      version: '3.0.14',
      description: 'The official addon for movie and series catalogs',
      host: '127.0.0.1',
      types: ['movie', 'series'],
      enabled: true,
      position: 0,
      fetchedAt: '2026-09-27T12:00:00.000Z',
      refreshError: null,
    });
    expect(a.resources).toContainEqual({
      name: 'meta',
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
    });
    expect(a.catalogs[0]).toMatchObject({ type: 'movie', id: 'top', name: 'Popular' });
    expect(a.catalogs[0]?.extra.map((e) => e.name)).toEqual(['genre', 'search', 'skip']);

    const b = await t.add(torrentio.manifestUrl);
    expect(b).toMatchObject({ name: 'Torrentio RD', position: 1 });
    expect(b.resources).toEqual([
      { name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'] },
    ]);
    expect((await t.list()).map((x) => x.id)).toEqual([a.id, b.id]);

    const reordered = await t.call('PUT', '/v1/admin/addons/order', { ids: [b.id, a.id] });
    expect(reordered.status).toBe(200);
    expect((reordered.json() as Addon[]).map((x) => [x.id, x.position])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);

    const disabled = await t.call('PATCH', `/v1/admin/addons/${a.id}`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.json()).toMatchObject({ id: a.id, enabled: false });
    const unchanged = await t.call('PATCH', `/v1/admin/addons/${a.id}`, {});
    expect(unchanged.json()).toMatchObject({ enabled: false });

    const removed = await t.call('DELETE', `/v1/admin/addons/${b.id}`);
    expect(removed.status).toBe(204);
    expect((await t.list()).map((x) => [x.id, x.position, x.enabled])).toEqual([[a.id, 0, false]]);

    // Persisted: a fresh service over the same database sees the same collection.
    const reloaded = new AddonService({
      config: t.config,
      db: t.db,
      logger: t.log.logger,
      clock: t.clock,
    });
    const records = await reloaded.collection.list();
    expect(records.map((r) => [r.id, r.position, r.enabled, r.manifest.name])).toEqual([
      [a.id, 0, false, 'Cinemeta'],
    ]);
  });

  it('never returns or logs the manifest URL', async () => {
    const t = await setup();
    const torrentio = await fake({ fixture: 'torrentio-rd', prefix: `/${SECRET}` });
    const added = await t.add(torrentio.manifestUrl);
    await t.call('POST', '/v1/admin/addons', { manifestUrl: torrentio.manifestUrl }); // duplicate
    await t.call('POST', `/v1/admin/addons/${added.id}/refresh`);
    torrentio.set({ manifestMode: 'error' });
    await t.call('POST', '/v1/admin/addons/refresh');
    await t.call('POST', '/v1/admin/addons', {
      manifestUrl: torrentio.manifestUrl.replace('manifest.json', 'x/manifest.json'),
    });
    torrentio.set({ mode: 'error' });
    await t.addons.aggregate('stream', 'movie', 'tt1375666');
    await t.call('GET', '/v1/admin/addons');

    const everything = t.bodies.join('\n') + t.log.text();
    expect(t.log.lines().length).toBeGreaterThan(0);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('manifest.json');
    expect(everything).toContain('127.0.0.1');
  });

  it('rejects duplicates with 409, and invalid or legacy URLs with 400', async () => {
    const t = await setup();
    const cinemeta = await fake({ fixture: 'cinemeta' });
    await t.add(cinemeta.manifestUrl);

    const dup = await t.call('POST', '/v1/admin/addons', {
      manifestUrl: `${cinemeta.manifestUrl}#again`,
    });
    expect(dup.status).toBe(409);
    expect(dup.type).toBe(PROBLEM_CONTENT_TYPE);
    expect(dup.json()).toMatchObject({ status: 409 });
    expect(detailOf(dup)).toMatch(/already installed/);

    const legacy = await t.call('POST', '/v1/admin/addons', {
      manifestUrl: `${cinemeta.origin}/stremio/v1`,
    });
    expect(legacy.status).toBe(400);
    expect(detailOf(legacy)).toMatch(/legacy/);

    const invalid = await t.call('POST', '/v1/admin/addons', { manifestUrl: 'nope' });
    expect(invalid.status).toBe(400);

    const missing = await t.call('POST', '/v1/admin/addons', {});
    expect(missing.status).toBe(400);
    expect(missing.json()).toMatchObject({ errors: [{ in: 'json', path: 'manifestUrl' }] });

    expect(await t.list()).toHaveLength(1);
  });

  it('rejects an addon whose manifest is unavailable or invalid with 400', async () => {
    const t = await setup();
    const broken = await fake({ fixture: 'cinemeta', manifestMode: 'error' });
    const res = await t.call('POST', '/v1/admin/addons', { manifestUrl: broken.manifestUrl });
    expect(res.status).toBe(400);
    expect(detailOf(res)).toMatch(/http-status/);

    const invalid = await fake({ fixture: 'cinemeta', manifest: { version: 'one' } });
    const res2 = await t.call('POST', '/v1/admin/addons', { manifestUrl: invalid.manifestUrl });
    expect(res2.status).toBe(400);
    expect(detailOf(res2)).toMatch(/validation/);
    expect(await t.list()).toEqual([]);
  });

  it('answers 404 for unknown ids and 409 for an order that is not the collection', async () => {
    const t = await setup();
    const cinemeta = await fake({ fixture: 'cinemeta' });
    const youtube = await fake({ fixture: 'youtube' });
    const a = await t.add(cinemeta.manifestUrl);
    const b = await t.add(youtube.manifestUrl);

    for (const [method, path, body] of [
      ['PATCH', '/v1/admin/addons/nope', { enabled: true }],
      ['PATCH', '/v1/admin/addons/nope', {}],
      ['POST', '/v1/admin/addons/nope/refresh', undefined],
      ['DELETE', '/v1/admin/addons/nope', undefined],
    ] as const) {
      const res = await t.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json()).toMatchObject({ detail: 'No addon with this id.' });
    }

    for (const ids of [[a.id], [a.id, a.id], [a.id, b.id, 'nope'], [a.id, 'nope']]) {
      const res = await t.call('PUT', '/v1/admin/addons/order', { ids });
      expect(res.status, JSON.stringify(ids)).toBe(409);
    }
    expect((await t.list()).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('needs the admin scope', async () => {
    const t = await setup();
    const clientKey = (await createApiKey(t.db, { scope: 'client', label: 'c' }, t.clock)).key;
    const res = await t.app.request('/v1/admin/addons', { headers: bearer(clientKey) });
    expect(res.status).toBe(403);
    expect((await t.app.request('/v1/admin/addons')).status).toBe(404);
  });

  it('refresh keeps the last good manifest on failure and picks up changes on success', async () => {
    const t = await setup();
    const cinemeta = await fake({ fixture: 'cinemeta' });
    const added = await t.add(cinemeta.manifestUrl);

    t.clock.advance(60_000);
    cinemeta.set({ manifestMode: 'error' });
    const failed = await t.call('POST', `/v1/admin/addons/${added.id}/refresh`);
    expect(failed.status).toBe(200);
    expect(failed.json()).toMatchObject({
      name: 'Cinemeta',
      version: '3.0.14',
      fetchedAt: '2026-09-27T12:00:00.000Z',
      refreshError: { code: 'http-status', at: '2026-09-27T12:01:00.000Z' },
    });
    // Still routed to with the old manifest.
    const index = await t.addons.collection.index();
    expect(index.match({ resource: 'meta', type: 'movie', id: 'tt1' }).map((r) => r.id)).toEqual([
      added.id,
    ]);

    t.clock.advance(60_000);
    cinemeta.set({ manifestMode: 'ok', manifest: { version: '3.1.0', types: ['movie'] } });
    const all = await t.call('POST', '/v1/admin/addons/refresh');
    expect(all.status).toBe(200);
    expect(all.json()).toMatchObject([
      {
        version: '3.1.0',
        types: ['movie'],
        fetchedAt: '2026-09-27T12:02:00.000Z',
        refreshError: null,
      },
    ]);
    const after = await t.addons.collection.index();
    expect(after.match({ resource: 'meta', type: 'series', id: 'tt1' })).toEqual([]);
  });

  it('refreshes stale manifests on the schedule only', async () => {
    const t = await setup();
    const cinemeta = await fake({ fixture: 'cinemeta' });
    await t.add(cinemeta.manifestUrl);
    const manifestHits = () => cinemeta.requests.filter((p) => p === '/manifest.json').length;
    expect(manifestHits()).toBe(1);

    await t.addons.collection.refreshStale(t.config.addons.manifestRefreshMs);
    expect(manifestHits()).toBe(1);
    t.clock.advance(t.config.addons.manifestRefreshMs);
    await t.addons.collection.refreshStale(t.config.addons.manifestRefreshMs);
    expect(manifestHits()).toBe(2);
  });

  it('is declared in the OpenAPI document with its problem responses', () => {
    const doc = openApiDocument();
    const paths = doc.paths ?? {};
    expect(doc.components?.schemas).toHaveProperty('Addon');
    const expected: [string, 'get' | 'post' | 'put' | 'patch' | 'delete', string[]][] = [
      ['/v1/admin/addons', 'get', ['200', '403', '404']],
      ['/v1/admin/addons', 'post', ['201', '400', '403', '404', '409']],
      ['/v1/admin/addons/order', 'put', ['200', '400', '403', '404', '409']],
      ['/v1/admin/addons/refresh', 'post', ['200', '403', '404']],
      ['/v1/admin/addons/{id}', 'patch', ['200', '400', '403', '404']],
      ['/v1/admin/addons/{id}', 'delete', ['204', '400', '403', '404']],
      ['/v1/admin/addons/{id}/refresh', 'post', ['200', '400', '403', '404']],
    ];
    for (const [path, method, statuses] of expected) {
      const op = paths[path]?.[method];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op?.responses ?? {}).sort()).toEqual([...statuses].sort());
    }
  });
});
