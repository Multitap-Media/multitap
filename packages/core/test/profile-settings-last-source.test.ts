/**
 * Per-profile settings and the last source per item (gap analysis items 2 and
 * 9; okf:architecture/library-and-profiles, okf:architecture/last-source-per-item, okf:concept/source-ranking, okf:decision/auto-select-and-fallback): `PATCH /v1/profiles/{id}`, the
 * profile's languages in source lists and sessions (request > profile >
 * instance), and the remembered source (`lastSource`, `lastUsed`, the
 * auto-select bonus). Fake engine, fake addons from the redacted real
 * fixtures, manual clock.
 */
import {
  DEFAULT_PROFILE_SETTINGS,
  DEFAULT_RANKING_SETTINGS,
  LibraryItemListSchema,
  MAX_CLIENT_SETTINGS_BYTES,
  ProfileSchema,
  SourceListSchema,
  type CreateSession,
  type PlaybackSession,
  type SourceCandidate,
} from '@multitap/api';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngineId, getEngine } from '../src/engines/index.ts';
import { autoSourcesFor, libraryService } from '../src/http/selection-deps.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { toCandidate } from '../src/selection/candidates.ts';
import { annotate } from '../src/selection/rank.ts';
import { sessionIdentity } from '../src/sessions/identity.ts';
import { SessionError, SessionService } from '../src/sessions/service.ts';
import { startFakeAddon, type FakeAddon } from './fakes/addon.ts';
import { bearer } from './helpers.ts';
import { must } from './selection-fixtures.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const SERIES = 'tt0944947';
const EP1 = { type: 'series', id: SERIES, videoId: `${SERIES}:1:1` };

const rigs: Rig[] = [];
const addons: FakeAddon[] = [];
const services: SessionService[] = [];
afterEach(async () => {
  await Promise.all(addons.splice(0).map((a) => a.close()));
  for (const s of services.splice(0)) {
    s.stop();
    await s.idle();
  }
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});

/** A session rig whose own service knows profiles and ranks the real torrentio-rd list. */
async function setup(options: { env?: Record<string, string>; addon?: boolean } = {}) {
  const r = await sessionRig(options.env === undefined ? {} : { env: options.env });
  rigs.push(r);
  if (options.addon !== false) {
    const addon = await startFakeAddon({ fixture: 'torrentio-rd' });
    addons.push(addon);
    await r.addons.collection.add(addon.manifestUrl);
  }
  const library = libraryService(r.appDeps);
  const service = new SessionService({
    repo: r.repo,
    engines: r.module,
    getEngine: (id) => getEngine(r.db, id),
    defaultEngine: () => defaultEngineId(r.db, r.config.selection.defaultEngine),
    streams: r.streams,
    autoSources: autoSourcesFor(r.appDeps),
    config: r.config,
    clock: r.clock,
    ids: {
      ...sequentialIds(),
      playbackSession: (() => {
        let n = 0;
        return () => `ps_P${String((n += 1)).padStart(21, '0')}`;
      })(),
    },
    logger: r.log.logger,
    profiles: library,
  });
  services.push(service);
  const key = await r.keyFor('client');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await r.app.request(path, {
      method,
      headers: { ...bearer(key), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: () => JSON.parse(text) as unknown };
  };
  const createProfile = async (name = 'Host') =>
    ProfileSchema.parse((await call('POST', '/v1/profiles', { name })).json()).id;
  const ready = async (request: CreateSession): Promise<PlaybackSession> => {
    const { session } = await service.create(request);
    await service.idle();
    await r.module.idle();
    return must(await service.get(session.id));
  };
  const streams = async (videoId: string, query = '') => {
    const res = await call('GET', `/v1/streams/series/${videoId}?sort=rank&highRes=off${query}`);
    expect(res.status).toBe(200);
    return SourceListSchema.parse(res.json()).candidates;
  };
  return { r, library, service, call, createProfile, ready, streams };
}

describe('PATCH /v1/profiles/{id}', () => {
  it('renames and changes settings; GET shows them over the defaults; only what was set is stored', async () => {
    const t = await setup({ addon: false });
    const id = await t.createProfile();
    const patched = await t.call('PATCH', `/v1/profiles/${id}`, {
      name: ' Den ',
      settings: { audioLanguage: 'ita', bingeWatching: false, seekTimeDuration: 5000 },
    });
    expect(patched.status).toBe(200);
    const expected = {
      ...DEFAULT_PROFILE_SETTINGS,
      audioLanguage: 'ita',
      bingeWatching: false,
      seekTimeDuration: 5000,
    };
    expect(ProfileSchema.parse(patched.json())).toMatchObject({
      name: ' Den ',
      settings: expected,
    });
    const got = ProfileSchema.parse((await t.call('GET', `/v1/profiles/${id}`)).json());
    expect(got.settings).toEqual(expected);
    // Stored sparse: unset fields keep following the defaults.
    const row = await t.r.db
      .selectFrom('profiles')
      .select('settings_json')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(must(row.settings_json))).toEqual({
      audioLanguage: 'ita',
      bingeWatching: false,
      seekTimeDuration: 5000,
    });
    // A rename alone keeps the settings; null clears a language.
    await t.call('PATCH', `/v1/profiles/${id}`, { name: 'Den' });
    const cleared = await t.call('PATCH', `/v1/profiles/${id}`, {
      settings: { audioLanguage: null },
    });
    expect(ProfileSchema.parse(cleared.json())).toMatchObject({
      name: 'Den',
      settings: { audioLanguage: null, bingeWatching: false },
    });
  });

  it('merges the client bag key by key (null removes) within its size limit', async () => {
    const t = await setup({ addon: false });
    const id = await t.createProfile();
    const patch = async (client: Record<string, unknown>) =>
      t.call('PATCH', `/v1/profiles/${id}`, { settings: { client } });
    await patch({ escExitFullscreen: true, theme: { dark: true } });
    const merged = await patch({ theme: null, volume: 0.5 });
    expect(ProfileSchema.parse(merged.json()).settings.client).toEqual({
      escExitFullscreen: true,
      volume: 0.5,
    });
    // One patch over the limit, or a merge that ends over it: 400, nothing stored.
    const half = 'x'.repeat(MAX_CLIENT_SETTINGS_BYTES / 2);
    expect((await patch({ big: 'x'.repeat(MAX_CLIENT_SETTINGS_BYTES) })).status).toBe(400);
    expect((await patch({ a: half })).status).toBe(200);
    expect((await patch({ b: half })).status).toBe(400);
    const after = ProfileSchema.parse((await t.call('GET', `/v1/profiles/${id}`)).json());
    expect(Object.keys(after.settings.client).sort()).toEqual(['a', 'escExitFullscreen', 'volume']);
  });

  it.each([
    [{ settings: { escExitFullscreen: true } }],
    [{ settings: { audioLanguage: 'it' } }],
    [{ settings: { subtitlesTextColor: 'white' } }],
    [{ settings: { seekTimeDuration: -1 } }],
    [{ name: ' ' }],
    [{ name: 'x'.repeat(101) }],
    [{ nickname: 'x' }],
  ])('rejects %j with 400', async (body) => {
    const t = await setup({ addon: false });
    const id = await t.createProfile();
    expect((await t.call('PATCH', `/v1/profiles/${id}`, body)).status).toBe(400);
    const got = ProfileSchema.parse((await t.call('GET', `/v1/profiles/${id}`)).json());
    expect(got).toMatchObject({ name: 'Host', settings: DEFAULT_PROFILE_SETTINGS });
  });

  it('is a 404 for an unknown profile', async () => {
    const t = await setup({ addon: false });
    expect((await t.call('PATCH', '/v1/profiles/pr_nope', { name: 'x' })).status).toBe(404);
  });
});

describe("the profile's languages in selection", () => {
  it('GET /v1/streams uses the profile’s audio languages between the request and the instance', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.call('PATCH', `/v1/profiles/${id}`, { settings: { audioLanguage: 'fre' } });
    const scores = (list: SourceCandidate[]) => list.map((c) => [c.key, c.score]);
    const byProfile = await t.streams(EP1.videoId, `&profileId=${id}`);
    expect(scores(byProfile)).toEqual(
      scores(await t.streams(EP1.videoId, '&preferredLanguage=fre')),
    );
    expect(scores(byProfile)).not.toEqual(scores(await t.streams(EP1.videoId)));
    // The request's own list wins over the profile's.
    expect(scores(await t.streams(EP1.videoId, `&profileId=${id}&preferredLanguage=eng`))).toEqual(
      scores(await t.streams(EP1.videoId)),
    );
    // A profile without audio languages falls through to the instance default.
    await t.call('PATCH', `/v1/profiles/${id}`, { settings: { audioLanguage: null } });
    expect(scores(await t.streams(EP1.videoId, `&profileId=${id}`))).toEqual(
      scores(await t.streams(EP1.videoId)),
    );
    const unknown = await t.call('GET', `/v1/streams/series/${EP1.videoId}?profileId=pr_nope`);
    expect(unknown.status).toBe(400);
  });

  it("a session for a profile starts on the profile's audio language; unknown profiles are refused", async () => {
    const t = await setup({ addon: false, env: { MULTITAP_SELECTION_PREFERRED_LANGUAGE: 'deu' } });
    t.r.fake.setProbe('https://media.example/multi.mkv', 'multi-language');
    const id = await t.createProfile();
    await t.call('PATCH', `/v1/profiles/${id}`, { settings: { audioLanguage: 'ita' } });
    const key = t.r.list(httpStream('multi'));
    const session = await t.ready({ item: MOVIE, source: { key }, profileId: id });
    expect(session).toMatchObject({ status: 'ready', profileId: id, audioTrack: 1 });
    // Without the profile: the instance default (German).
    expect((await t.ready({ item: MOVIE, source: { key } })).audioTrack).toBe(2);

    await expect(
      t.service.create({ item: MOVIE, source: { key }, profileId: 'pr_nope' }),
    ).rejects.toSatisfy((err) => err instanceof SessionError && err.code === 'unknown-profile');
    const res = await t.call('POST', '/v1/sessions', {
      item: MOVIE,
      source: { key },
      profileId: 'pr_nope',
    });
    expect(res.status).toBe(400);
  });

  it("profileId is part of an auto session's identity only", () => {
    const base = {
      key: 'room:1',
      item: MOVIE,
      source: { auto: true as const },
      delivery: 'auto' as const,
      quality: undefined,
    };
    expect(sessionIdentity({ ...base, profileId: 'pr_a' })).not.toBe(sessionIdentity(base));
    expect(sessionIdentity({ ...base, profileId: undefined })).toBe(sessionIdentity(base));
    const picked = { ...base, source: { key: 'k' } };
    expect(sessionIdentity({ ...picked, profileId: 'pr_a' })).toBe(sessionIdentity(picked));
  });
});

describe('the last source per item', () => {
  /** A playable candidate below the top one, within the last-source bonus of it. */
  const runnerUp = (list: SourceCandidate[]) => {
    const top = must(list[0]);
    return must(
      list.find(
        (c) =>
          c.playable &&
          c.key !== top.key &&
          top.score - c.score < DEFAULT_RANKING_SETTINGS.lastSource.matchBonus,
      ),
    );
  };

  it('is recorded when a profile’s session is ready, flagged in the list, and preferred by auto-select', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const plain = await t.streams(EP1.videoId);
    const top = must(plain[0]);
    const second = runnerUp(plain);

    // The profile plays the runner-up (picked from the list).
    const played = await t.ready({ item: EP1, source: { key: second.key }, profileId: id });
    expect(played.status).toBe('ready');

    // The list for the profile flags it and ranks it up by the bonus.
    const forProfile = await t.streams(EP1.videoId, `&profileId=${id}`);
    const flagged = forProfile.filter((c) => c.lastUsed === true);
    expect(flagged.map((c) => c.key)).toEqual([second.key]);
    expect(must(flagged[0]).score - second.score).toBe(
      DEFAULT_RANKING_SETTINGS.lastSource.matchBonus,
    );
    expect(forProfile[0]?.key).toBe(second.key);
    // Not for another profile, nor without one.
    const other = await t.createProfile('Other');
    expect((await t.streams(EP1.videoId, `&profileId=${other}`)).some((c) => c.lastUsed)).toBe(
      false,
    );
    expect(plain.some((c) => c.lastUsed)).toBe(false);
    // explain names the rule.
    const explained = await t.streams(EP1.videoId, `&profileId=${id}&explain=true`);
    expect(
      must(explained.find((c) => c.key === second.key)).explain?.contributions.map((c) => c.rule),
    ).toContain('lastSource');

    // Auto-select for the profile plays it again; without the profile, the top one.
    const resumed = await t.ready({ item: EP1, source: { auto: true }, profileId: id });
    expect(resumed.chosen).toBe(second.key);
    expect(must(resumed.candidates)[0]?.lastUsed).toBe(true);
    const fresh = await t.ready({ item: EP1, source: { auto: true } });
    expect(fresh.chosen).toBe(top.key);

    // The library and continue watching show it, with no secrets.
    const progress = await t.call('POST', `/v1/profiles/${id}/progress`, {
      item: { type: 'series', id: SERIES },
      videoId: EP1.videoId,
      time: 600_000,
      duration: 3_000_000,
      event: 'pause',
      name: 'Game of Thrones',
    });
    expect(progress.status).toBe(200);
    for (const path of ['library', 'continue']) {
      const items = LibraryItemListSchema.parse(
        (await t.call('GET', `/v1/profiles/${id}/${path}`)).json(),
      ).items;
      expect(items).toHaveLength(1);
      expect(must(items[0]).lastSource).toEqual({
        sourceIdentity: second.key,
        videoId: EP1.videoId,
        addonId: second.addonId,
        addonName: second.addonName,
        name: second.name,
        title: second.title,
        ...(second.bingeGroup === undefined ? {} : { bingeGroup: second.bingeGroup }),
        playedAt: '2026-09-27T12:00:00.000Z',
      });
      expect(JSON.stringify(items)).not.toMatch(/https?:\/\/|infoHash|redacted\//);
    }
    // One row per item: the latest session replaces it.
    const rows = await sql<{ n: number }>`select count(*) as n from last_sources`.execute(t.r.db);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('changes nothing when the remembered source is no longer offered', async () => {
    const t = await setup();
    const id = await t.createProfile();
    await t.library.recordLastSource(id, {
      itemId: SERIES,
      videoId: EP1.videoId,
      sourceIdentity: 'gone-gone-gone-gone-gone-gone-go',
      addonId: 'old',
      addonName: 'Old',
      name: 'Old',
      title: 'Old release',
    });
    const plain = await t.streams(EP1.videoId);
    const forProfile = await t.streams(EP1.videoId, `&profileId=${id}`);
    expect(forProfile.map((c) => [c.key, c.score])).toEqual(plain.map((c) => [c.key, c.score]));
    expect(forProfile.some((c) => c.lastUsed)).toBe(false);
    const session = await t.ready({ item: EP1, source: { auto: true }, profileId: id });
    expect(session.chosen).toBe(plain[0]?.key);
  });

  it('never makes an unplayable source playable', () => {
    const external = must(
      toCandidate({ id: 'a', name: 'A' }, {
        externalUrl: 'https://example.invalid/watch',
        name: 'Ext',
        behaviorHints: {},
      } as never),
    );
    const [ranked] = annotate(
      [external],
      { id: 'home', capabilities: { liveMaxHeight: 1080, preparedMaxHeight: 2160 } } as never,
      'off',
      { settings: DEFAULT_RANKING_SETTINGS, lastSource: external.key },
    );
    expect(ranked?.playable).toBe(false);
    expect(ranked?.unplayableReason).toBe('external');
  });

  it('is deleted with its profile, and a session whose profile is gone records nothing', async () => {
    const t = await setup({ addon: false });
    const id = await t.createProfile();
    const key = t.r.list(httpStream('one'));
    await t.ready({ item: MOVIE, source: { key }, profileId: id });
    const count = async () =>
      (await sql<{ n: number }>`select count(*) as n from last_sources`.execute(t.r.db)).rows[0]?.n;
    expect(await count()).toBe(1);
    // Picked from a list the rig filled directly: the addon id stands in for its name.
    const row = await t.r.db.selectFrom('last_sources').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ item_id: MOVIE.id, video_id: MOVIE.id, addon_name: 'fake-addon' });

    const gone = await t.createProfile('Gone');
    const { session } = await t.service.create({ item: MOVIE, source: { key }, profileId: gone });
    expect((await t.call('DELETE', `/v1/profiles/${gone}`)).status).toBe(204);
    await t.service.idle();
    await t.r.module.idle();
    expect((await t.service.get(session.id))?.status).toBe('ready');
    expect((await t.call('DELETE', `/v1/profiles/${id}`)).status).toBe(204);
    expect(await count()).toBe(0);
  });
});
