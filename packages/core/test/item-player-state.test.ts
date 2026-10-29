/**
 * Per-item player state (phase 3 P1, stremio-core's `StreamItemState`;
 * okf:architecture/library-and-profiles, okf:architecture/core-subtitles-and-player-state): `GET`/`PUT /v1/profiles/{id}/items/{type}/{itemId}/state`,
 * the state on library items, and what a session created for the profile takes
 * from it (`audioLanguage`, the subtitle offset). Fake engine, manual clock,
 * offline.
 */
import {
  EMPTY_ITEM_PLAYER_STATE,
  ItemPlayerStateSchema,
  LibraryItemListSchema,
  ProfileSchema,
  type CreateSession,
  type PlaybackSession,
} from '@multitap/api';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngineId, getEngine } from '../src/engines/index.ts';
import { autoSourcesFor, libraryService } from '../src/http/selection-deps.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { SessionService } from '../src/sessions/service.ts';
import { bearer } from './helpers.ts';
import { must } from './selection-fixtures.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const FILE_ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const rigs: Rig[] = [];
const services: SessionService[] = [];
afterEach(async () => {
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

async function setup() {
  const r = await sessionRig();
  rigs.push(r);
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
        return () => `ps_S${String((n += 1)).padStart(21, '0')}`;
      })(),
    },
    logger: r.log.logger,
    profiles: libraryService(r.appDeps),
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
  const createProfile = async () =>
    ProfileSchema.parse((await call('POST', '/v1/profiles', { name: 'Host' })).json()).id;
  const ready = async (request: CreateSession): Promise<PlaybackSession> => {
    const { session } = await service.create(request);
    await service.idle();
    await r.module.idle();
    return must(await service.get(session.id));
  };
  return { r, service, call, createProfile, ready };
}

const statePath = (id: string, type = 'movie', itemId: string = MOVIE.id) =>
  `/v1/profiles/${id}/items/${type}/${itemId}/state`;

describe('GET/PUT /v1/profiles/{id}/items/{type}/{itemId}/state', () => {
  it('starts empty, merges the fields given, clears with null, and stamps updatedAt', async () => {
    const t = await setup();
    const id = await t.createProfile();

    const empty = await t.call('GET', statePath(id));
    expect(empty.status).toBe(200);
    expect(ItemPlayerStateSchema.parse(empty.json())).toEqual(EMPTY_ITEM_PLAYER_STATE);

    const first = await t.call('PUT', statePath(id), {
      audioLanguage: 'ita',
      subtitle: { kind: 'addon', lang: 'eng', addonId: 'org.example.subs', fileId: FILE_ID },
      subtitleOffsetMs: -1500,
    });
    expect(first.status).toBe(200);
    const written = {
      audioLanguage: 'ita',
      subtitle: { kind: 'addon', lang: 'eng', addonId: 'org.example.subs', fileId: FILE_ID },
      subtitleOffsetMs: -1500,
      playbackSpeed: null,
      updatedAt: new Date(t.r.clock()).toISOString(),
    };
    expect(ItemPlayerStateSchema.parse(first.json())).toEqual(written);
    expect((await t.call('GET', statePath(id))).json()).toEqual(written);

    t.r.clock.advance(1_000);
    const second = await t.call('PUT', statePath(id), {
      playbackSpeed: 1.25,
      subtitle: { kind: 'off' },
      audioLanguage: null,
    });
    expect(second.status).toBe(200);
    expect(second.json()).toEqual({
      audioLanguage: null,
      subtitle: { kind: 'off' },
      subtitleOffsetMs: -1500,
      playbackSpeed: 1.25,
      updatedAt: new Date(t.r.clock()).toISOString(),
    });

    // Keyed per profile and item: another item and another profile are untouched.
    expect((await t.call('GET', statePath(id, 'movie', 'tt0000002'))).json()).toEqual(
      EMPTY_ITEM_PLAYER_STATE,
    );
    const other = await t.createProfile();
    expect((await t.call('GET', statePath(other))).json()).toEqual(EMPTY_ITEM_PLAYER_STATE);
  });

  it('is 404 for an unknown profile and 400 for an invalid body', async () => {
    const t = await setup();
    expect((await t.call('GET', statePath('pr_nope'))).status).toBe(404);
    expect((await t.call('PUT', statePath('pr_nope'), { audioLanguage: 'eng' })).status).toBe(404);
    const id = await t.createProfile();
    for (const body of [
      { unknown: true },
      { audioLanguage: 'English' },
      { subtitle: { kind: 'embedded', lang: 'eng' } },
      { subtitle: { kind: 'addon', lang: 'eng', addonId: 'a', fileId: 'short' } },
      { subtitle: { kind: 'off', lang: 'eng' } },
      { subtitleOffsetMs: 600_001 },
      { subtitleOffsetMs: 1.5 },
      { playbackSpeed: 0 },
      { playbackSpeed: 17 },
    ]) {
      expect((await t.call('PUT', statePath(id), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await t.call('GET', statePath(id))).json()).toEqual(EMPTY_ITEM_PLAYER_STATE);
  });

  it('shows on library items, and is deleted with the profile', async () => {
    const t = await setup();
    const id = await t.createProfile();
    const progress = await t.call('POST', `/v1/profiles/${id}/progress`, {
      item: MOVIE,
      time: 60_000,
      duration: 6_000_000,
      event: 'pause',
      name: 'A movie',
    });
    expect(progress.status).toBe(200);
    const before = LibraryItemListSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/library`)).json(),
    );
    expect(before.items[0]?.playerState).toBeUndefined();

    await t.call('PUT', statePath(id), { subtitle: { kind: 'embedded', lang: null, index: 1 } });
    const after = LibraryItemListSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/library`)).json(),
    );
    expect(after.items[0]?.playerState?.subtitle).toEqual({
      kind: 'embedded',
      lang: null,
      index: 1,
    });
    const cw = LibraryItemListSchema.parse(
      (await t.call('GET', `/v1/profiles/${id}/continue`)).json(),
    );
    expect(cw.items[0]?.playerState?.subtitle?.kind).toBe('embedded');

    expect((await t.call('DELETE', `/v1/profiles/${id}`)).status).toBe(204);
    const rows = await sql<{ n: number }>`select count(*) as n from item_player_states`.execute(
      t.r.db,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});

describe('a session created for the profile', () => {
  it("takes audioLanguage from the item's state when the request names none", async () => {
    const t = await setup();
    t.r.fake.setProbe('https://media.example/multi.mkv', 'multi-language');
    const key = t.r.list(httpStream('multi'));
    const id = await t.createProfile();
    await t.call('PUT', statePath(id), { audioLanguage: 'ita' });

    const fromState = await t.ready({ item: MOVIE, source: { key }, profileId: id });
    expect(fromState.status).toBe('ready');
    expect(fromState.audioTrack).toBe(1);

    const asked = await t.ready({
      item: MOVIE,
      source: { key },
      profileId: id,
      audioLanguage: 'deu',
    });
    expect(asked.audioTrack).toBe(2);

    // A state stored for another item doesn't apply.
    const other = await t.createProfile();
    await t.call('PUT', statePath(other, 'movie', 'tt0000009'), { audioLanguage: 'ita' });
    const baseline = await t.ready({ item: MOVIE, source: { key } });
    const unrelated = await t.ready({ item: MOVIE, source: { key }, profileId: other });
    expect(baseline.audioTrack).not.toBe(1);
    expect(unrelated.audioTrack).toBe(baseline.audioTrack);
  });

  it("seeds the session's subtitle offset on the chosen addon file, and only then", async () => {
    const t = await setup();
    const key = t.r.list(httpStream('single'));
    const id = await t.createProfile();

    await t.call('PUT', statePath(id), {
      subtitle: { kind: 'addon', lang: 'eng', addonId: 'org.example.subs', fileId: FILE_ID },
      subtitleOffsetMs: -1500,
    });
    const seeded = await t.ready({ item: MOVIE, source: { key }, profileId: id });
    expect(Object.fromEntries(await t.r.repo.listSubtitleOffsets(seeded.id))).toEqual({
      [FILE_ID]: -1500,
    });

    // Without a profile, or with an embedded choice or offset 0, nothing is seeded.
    const anonymous = await t.ready({ item: MOVIE, source: { key } });
    expect((await t.r.repo.listSubtitleOffsets(anonymous.id)).size).toBe(0);
    await t.call('PUT', statePath(id), { subtitle: { kind: 'embedded', lang: 'eng', index: 0 } });
    const embedded = await t.ready({ item: MOVIE, source: { key }, profileId: id, key: 'k2' });
    expect((await t.r.repo.listSubtitleOffsets(embedded.id)).size).toBe(0);
  });
});
