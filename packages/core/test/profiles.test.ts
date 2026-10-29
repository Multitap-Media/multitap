import {
  DEFAULT_PROFILE_SETTINGS,
  LibraryItemListSchema,
  LibraryItemSchema,
  NextVideoSchema,
  ProfileListSchema,
  ProfileSchema,
  type LibraryItem,
  type MetaDetail,
  type ProgressReport,
} from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/http/app.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { LibraryService, type MetaSource } from '../src/library/service.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

const HOUR = 3_600_000;

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
const MOVIE: MetaDetail = {
  ...SERIES,
  id: 'tt1375666',
  type: 'movie',
  name: 'Inception',
  videos: [],
};

async function setup(options: { meta?: MetaSource } = {}) {
  const db = await migratedMemoryDb();
  const log = memoryLogger();
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: 'test' });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const metaCalls: string[] = [];
  const meta: MetaSource =
    options.meta ??
    ((type, id) => {
      metaCalls.push(`${type}/${id}`);
      return Promise.resolve([SERIES, MOVIE].find((m) => m.type === type && m.id === id));
    });
  const library = new LibraryService({
    db,
    clock,
    logger: log.logger,
    meta,
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
    const init: RequestInit = { method, headers: { ...bearer(key) } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...bearer(key), 'Content-Type': 'application/json' };
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, json: () => JSON.parse(text) as unknown };
  };
  const createProfile = async () =>
    ProfileSchema.parse((await call('POST', '/v1/profiles', { name: 'Living room' })).json()).id;
  const report = async (profileId: string, body: ProgressReport) => {
    const res = await call('POST', `/v1/profiles/${profileId}/progress`, body);
    expect(res.status).toBe(200);
    return LibraryItemSchema.parse(res.json());
  };
  const stored = async (profileId: string): Promise<LibraryItem[]> =>
    LibraryItemListSchema.parse((await call('GET', `/v1/profiles/${profileId}/library`)).json())
      .items;
  return { db, clock, app, call, createProfile, report, stored, library, metaCalls, log };
}

const ep = (n: number) => `tt0903747:1:${String(n)}`;
const series = { type: 'series', id: 'tt0903747' };

describe('/v1/profiles', () => {
  it('creates, lists, gets and deletes profiles', async () => {
    const t = await setup();
    const created = await t.call('POST', '/v1/profiles', { name: ' Living room ' });
    expect(created.status).toBe(201);
    expect(created.json()).toEqual({
      id: 'pr_P000000000000000000001',
      name: ' Living room ',
      createdAt: '2026-09-27T12:00:00.000Z',
      settings: DEFAULT_PROFILE_SETTINGS,
    });
    t.clock.advance(1);
    await t.call('POST', '/v1/profiles', { name: 'Den' });
    const list = ProfileListSchema.parse((await t.call('GET', '/v1/profiles')).json());
    expect(list.profiles.map((p) => p.name)).toEqual([' Living room ', 'Den']);
    expect((await t.call('GET', '/v1/profiles/pr_P000000000000000000001')).status).toBe(200);
    expect((await t.call('DELETE', '/v1/profiles/pr_P000000000000000000001')).status).toBe(204);
    expect((await t.call('GET', '/v1/profiles/pr_P000000000000000000001')).status).toBe(404);
    expect((await t.call('DELETE', '/v1/profiles/pr_P000000000000000000001')).status).toBe(404);
    for (const name of [' ', '', '', 'x'.repeat(101)]) {
      expect((await t.call('POST', '/v1/profiles', { name })).status).toBe(400);
    }
    expect((await t.call('POST', '/v1/profiles', { name: ' ' + 'x'.repeat(99) })).status).toBe(201);
  });

  it('answers 404 for every library route of an unknown profile', async () => {
    const t = await setup();
    for (const [method, path, body] of [
      ['GET', '/v1/profiles/nope/library'],
      ['GET', '/v1/profiles/nope/continue'],
      ['GET', '/v1/profiles/nope/next/series/tt0903747'],
      ['POST', '/v1/profiles/nope/progress', { item: series, time: 1, duration: 2 }],
    ] as const) {
      expect((await t.call(method, path, body)).status).toBe(404);
    }
  });

  it('needs an API key', async () => {
    const t = await setup();
    expect((await t.app.request('/v1/profiles')).status).toBe(404);
  });

  it('deleting a profile deletes its library', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, { item: series, videoId: ep(1), time: 1_000, duration: HOUR });
    expect(await t.stored(id)).toHaveLength(1);
    await t.call('DELETE', `/v1/profiles/${id}`);
    expect(await t.db.selectFrom('library_items').selectAll().execute()).toEqual([]);
  });
});

describe('progress', () => {
  it('writes the first report, then at most every 90 s, and at once on pause', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const first = await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 10_000,
      duration: HOUR,
    });
    expect(first).toMatchObject({
      _id: 'tt0903747',
      name: 'Breaking Bad',
      removed: true,
      temp: true,
      // The first update of a new video counts no time (stremio-core's video switch).
      state: { video_id: ep(1), timeOffset: 10_000, timeWatched: 0, duration: HOUR },
    });
    expect((await t.stored(id))[0]?.state.timeOffset).toBe(10_000);

    t.clock.advance(60_000);
    const later = await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 70_000,
      duration: HOUR,
    });
    expect(later.state.timeOffset).toBe(70_000);
    expect((await t.stored(id))[0]?.state.timeOffset).toBe(10_000); // throttled

    t.clock.advance(30_000);
    await t.report(id, { item: series, videoId: ep(1), time: 100_000, duration: HOUR });
    const [written] = await t.stored(id);
    expect(written?.state.timeOffset).toBe(100_000);
    expect(written?._mtime).toBe(new Date(t.clock()).toISOString());

    t.clock.advance(5_000);
    await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 105_000,
      duration: HOUR,
      event: 'pause',
    });
    expect((await t.stored(id))[0]?.state.timeOffset).toBe(105_000);
    // The meta was looked up once for the playback.
    expect(t.metaCalls).toEqual(['series/tt0903747']);
  });

  it('flags watched, then moves on to the next episode when stopped past the credits', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const base = { item: series, videoId: ep(1), duration: HOUR };
    await t.report(id, { ...base, time: 0 });
    for (let time = 0.1 * HOUR; time <= 0.95 * HOUR; time += 0.05 * HOUR) {
      t.clock.advance(0.05 * HOUR);
      await t.report(id, { ...base, time: Math.round(time) });
    }
    const stopped = await t.report(id, { ...base, time: 0.95 * HOUR, event: 'stop' });
    expect(stopped).toMatchObject({
      removed: true,
      temp: true,
      state: { video_id: ep(2), timeOffset: 1, timeWatched: 0, timesWatched: 1, flaggedWatched: 0 },
    });
    expect(stopped.state.watched).toMatch(/^tt0903747:1:1:1:/);

    const cw = LibraryItemListSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/continue`)).json(),
    );
    expect(cw.items.map((i) => i.state.video_id)).toEqual([ep(2)]);

    const next = NextVideoSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/next/series/tt0903747`)).json(),
    );
    expect(next.videoId).toBe(ep(2));
    expect(next.video?.title).toBe('Episode 2');
    expect(next.libraryItem?.state.video_id).toBe(ep(2));
  });

  it('a report for another item unloads and writes the previous one at once', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, { item: series, videoId: ep(3), time: 1_000, duration: HOUR });
    t.clock.advance(10_000);
    await t.report(id, { item: series, videoId: ep(3), time: 0.95 * HOUR, duration: HOUR });
    expect((await t.stored(id))[0]?.state.timeOffset).toBe(1_000);
    await t.report(id, { item: { type: 'movie', id: 'tt1375666' }, time: 5_000, duration: HOUR });
    const items = await t.stored(id);
    const show = items.find((i) => i._id === 'tt0903747');
    // The last episode, past the credits: nothing to continue.
    expect(show?.state).toMatchObject({ video_id: ep(3), timeOffset: 0 });
    const movie = items.find((i) => i._id === 'tt1375666');
    expect(movie?.state).toMatchObject({ video_id: 'tt1375666', timeOffset: 5_000, watched: null });
  });

  it('switching episodes resets the offset and counts from the new video', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, { item: series, videoId: ep(1), time: 0, duration: HOUR });
    await t.report(id, { item: series, videoId: ep(1), time: 0.3 * HOUR, duration: HOUR });
    t.clock.advance(1_000);
    const switched = await t.report(id, {
      item: series,
      videoId: ep(3),
      time: 2_000,
      duration: HOUR,
    });
    expect(switched.state).toMatchObject({
      video_id: ep(3),
      timeOffset: 2_000,
      timeWatched: 0,
      // stremio-core adds time watched to the total on every update and again on a
      // video switch; ported as is.
      overallTimeWatched: 2 * 0.3 * HOUR,
    });
  });

  it('seeks move the position without counting time watched', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const base = { item: series, videoId: ep(1), duration: HOUR };
    await t.report(id, { ...base, time: 0 });
    await t.report(id, { ...base, time: 1_000 });
    const sought = await t.report(id, { ...base, time: 0.8 * HOUR, event: 'seek' });
    expect(sought.state).toMatchObject({ timeOffset: 0.8 * HOUR, timeWatched: 1_000 });
    const after = await t.report(id, { ...base, time: 0.8 * HOUR + 1_000 });
    expect(after.state).toMatchObject({ timeWatched: 2_000, flaggedWatched: 0 });
  });

  it('works without a meta, from the report', async () => {
    const t = await setup({ meta: () => Promise.reject(new Error('addon down')) });
    const id = await t.createProfile();
    const item = await t.report(id, {
      item: { type: 'movie', id: 'tt9999999' },
      time: 1_000,
      duration: HOUR,
      name: 'Unknown film',
      poster: 'https://img.example.invalid/p.jpg',
      event: 'stop',
    });
    expect(item).toMatchObject({
      name: 'Unknown film',
      poster: 'https://img.example.invalid/p.jpg',
      state: { video_id: 'tt9999999', timeOffset: 1_000 },
    });
    const next = await t.call('GET', `/v1/profiles/${id}/next/movie/tt9999999`);
    expect(next.status).toBe(404);
  });

  it('serializes concurrent reports per profile', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        t.report(id, { item: series, videoId: ep(1), time: n * 1_000, duration: HOUR }),
      ),
    );
    expect(t.metaCalls).toHaveLength(1);
  });

  it('flush writes progress held back by the throttle', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, { item: series, videoId: ep(1), time: 1_000, duration: HOUR });
    t.clock.advance(1_000);
    await t.report(id, { item: series, videoId: ep(1), time: 2_000, duration: HOUR });
    await t.library.flush();
    expect((await t.stored(id))[0]?.state.timeOffset).toBe(2_000);
  });

  it('next is null for a movie', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const next = NextVideoSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/next/movie/tt1375666`)).json(),
    );
    expect(next).toEqual({ videoId: null, video: null, libraryItem: null });
  });
});

describe('library writes', () => {
  const lib = (id: string, suffix = '') => `/v1/profiles/${id}/library/series/tt0903747${suffix}`;
  const item = (res: { json: () => unknown }) => LibraryItemSchema.parse(res.json());

  it('adds, lists with filters, removes and re-adds; progress is kept', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 5_000,
      duration: HOUR,
      event: 'stop',
    });
    expect((await t.stored(id))[0]).toMatchObject({ removed: true, temp: true });

    t.clock.advance(1_000);
    const added = item(await t.call('PUT', lib(id)));
    expect(added).toMatchObject({
      _id: 'tt0903747',
      name: 'Breaking Bad',
      removed: false,
      temp: false,
    });
    expect(added.state.video_id).toBe(ep(1));
    expect(added._mtime).toBe(new Date(t.clock()).toISOString());
    expect((await t.stored(id))[0]).toEqual(added);

    const filtered = async (query: string) =>
      LibraryItemListSchema.parse(
        (await t.call('GET', `/v1/profiles/${id}/library${query}`)).json(),
      ).items.map((i) => i._id);
    // A second, removed item for the filters.
    await t.report(id, {
      item: { type: 'movie', id: 'tt1375666' },
      time: 1_000,
      duration: HOUR,
      event: 'stop',
    });
    expect(await filtered('')).toHaveLength(2);
    expect(await filtered('?removed=false')).toEqual(['tt0903747']);
    expect(await filtered('?removed=true')).toEqual(['tt1375666']);
    expect(await filtered('?type=movie')).toEqual(['tt1375666']);
    expect(await filtered('?type=movie&removed=false')).toEqual([]);
    expect((await t.call('GET', `/v1/profiles/${id}/library?removed=maybe`)).status).toBe(400);

    t.clock.advance(1_000);
    const removed = item(await t.call('DELETE', lib(id)));
    expect(removed).toMatchObject({ removed: true, temp: false });
    expect(removed.state.video_id).toBe(ep(1));
    const cw = LibraryItemListSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/continue`)).json(),
    );
    expect(cw.items.map((i) => i._id)).toEqual(['tt1375666']);
    // Adding twice changes nothing the second time.
    const again = item(await t.call('PUT', lib(id)));
    t.clock.advance(1_000);
    expect(item(await t.call('PUT', lib(id)))._mtime).toBe(again._mtime);
  });

  it('answers 404 for an unknown profile, item or meta', async () => {
    const t = await setup();
    const id = await t.createProfile();
    for (const [method, path, body] of [
      ['PUT', lib('nope')],
      ['DELETE', lib('nope')],
      ['POST', lib('nope', '/rewind')],
      ['POST', lib('nope', '/watched'), { watched: true }],
      ['POST', lib('nope', `/videos/${ep(1)}/watched`), { watched: true }],
      ['POST', lib('nope', '/seasons/1/watched'), { watched: true }],
      ['DELETE', lib(id)],
      ['POST', lib(id, '/rewind')],
      ['POST', lib(id, '/watched'), { watched: false }],
      ['POST', lib(id, `/videos/${ep(1)}/watched`), { watched: false }],
      ['PUT', `/v1/profiles/${id}/library/series/unknown`],
      ['POST', `/v1/profiles/${id}/library/series/unknown/watched`, { watched: true }],
      ['POST', lib(id, '/videos/nope/watched'), { watched: true }],
      ['POST', lib(id, '/seasons/9/watched'), { watched: true }],
    ] as const) {
      expect((await t.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await t.call('POST', lib(id, '/watched'), { watched: 'yes' })).status).toBe(400);
    expect((await t.call('POST', lib(id, '/seasons/x/watched'), { watched: true })).status).toBe(
      400,
    );
    expect(await t.stored(id)).toEqual([]);
  });

  it('rewinds and marks the item watched or unwatched', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 5_000,
      duration: HOUR,
      event: 'pause',
    });
    t.clock.advance(1_000);
    expect(item(await t.call('POST', lib(id, '/rewind'))).state).toMatchObject({
      timeOffset: 0,
      video_id: ep(1),
    });
    t.clock.advance(1_000);
    const watched = item(await t.call('POST', lib(id, '/watched'), { watched: true }));
    expect(watched.state.timesWatched).toBe(1);
    expect(watched.state.lastWatched).toBe(new Date(t.clock()).toISOString());
    const twice = item(await t.call('POST', lib(id, '/watched'), { watched: true }));
    expect(twice.state.timesWatched).toBe(2);
    const reset = item(await t.call('POST', lib(id, '/watched'), { watched: false }));
    expect(reset.state.timesWatched).toBe(0);
  });

  it('marking watched an unstored item creates it removed and temp', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const created = item(await t.call('POST', lib(id, '/watched'), { watched: true }));
    expect(created).toMatchObject({ removed: true, temp: true, state: { timesWatched: 1 } });
    expect(await t.stored(id)).toEqual([created]);
  });

  it('marks a video watched and moves the resume pointer on', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, {
      item: series,
      videoId: ep(1),
      time: 5_000,
      duration: HOUR,
      event: 'pause',
    });
    t.clock.advance(1_000);
    const path = lib(id, `/videos/${ep(1)}/watched`);
    const marked = item(await t.call('POST', path, { watched: true }));
    expect(marked.state).toMatchObject({ video_id: ep(2), timeOffset: 1 });
    expect(marked.state.watched).not.toBeNull();
    const next = NextVideoSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/next/series/tt0903747`)).json(),
    );
    expect(next.videoId).toBe(ep(2));
    const unmarked = item(await t.call('POST', path, { watched: false }));
    expect(unmarked.state.video_id).toBe(ep(2));
    expect(unmarked.state.watched).not.toBe(marked.state.watched);
  });

  it('marks a season watched; the last episode clears the position', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.report(id, {
      item: series,
      videoId: ep(3),
      time: 5_000,
      duration: HOUR,
      event: 'pause',
    });
    const path = lib(id, '/seasons/1/watched');
    const marked = item(await t.call('POST', path, { watched: true }));
    expect(marked.state).toMatchObject({ video_id: ep(3), timeOffset: 0 });
    const unmarked = item(await t.call('POST', path, { watched: false }));
    expect(unmarked.state.video_id).toBe(ep(3));
  });

  it('edits the item being played in place: the next progress write keeps the edit', async () => {
    const t = await setup();
    const id = await t.createProfile();
    // Throttled: the second report is not written yet.
    await t.report(id, { item: series, videoId: ep(1), time: 1_000, duration: HOUR });
    t.clock.advance(1_000);
    await t.report(id, { item: series, videoId: ep(1), time: 2_000, duration: HOUR });
    const added = item(await t.call('PUT', lib(id)));
    expect(added).toMatchObject({ removed: false, temp: false });
    expect(added.state.timeOffset).toBe(2_000);
    t.clock.advance(100_000);
    await t.report(id, { item: series, videoId: ep(1), time: 3_000, duration: HOUR });
    expect((await t.stored(id))[0]).toMatchObject({
      removed: false,
      temp: false,
      state: { timeOffset: 3_000 },
    });
  });

  it('serializes writes with progress per profile', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await Promise.all([
      t.call('PUT', lib(id)),
      t.report(id, { item: series, videoId: ep(1), time: 1_000, duration: HOUR }),
      t.call('POST', lib(id, '/watched'), { watched: true }),
    ]);
    expect(await t.stored(id)).toHaveLength(1);
  });
});
