/**
 * Per-request audio language, the session's track list and `audioTrack`, and
 * bingeGroup auto-next (gap analysis items 3 and 4; okf:concept/source-ranking, okf:decision/auto-select-and-fallback,
 * okf:architecture/playback-session), against the fake engine and the fake addons built from real,
 * redacted fixtures.
 */
import {
  DEFAULT_RANKING_SETTINGS,
  PlaybackSessionSchema,
  type CreateSession,
  type PlaybackSession,
} from '@multitap/api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngineId, getEngine } from '../src/engines/index.ts';
import { autoSourcesFor } from '../src/http/selection-deps.ts';
import { chooseAudioTrack, resolvePreferredLanguages } from '../src/selection/index.ts';
import { sessionIdentity } from '../src/sessions/identity.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { SessionService } from '../src/sessions/service.ts';
import { FIXTURES_DIR, startFakeAddon, type FakeAddon } from './fakes/addon.ts';
import { bearer } from './helpers.ts';
import { must } from './selection-fixtures.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

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

async function rig(env?: Record<string, string>) {
  const r = await sessionRig(env === undefined ? {} : { env });
  rigs.push(r);
  return r;
}

async function ready(
  r: Rig,
  request: CreateSession,
  service = r.service,
): Promise<PlaybackSession> {
  const { session } = await service.create(request);
  await service.idle();
  await r.module.idle();
  return must(await service.get(session.id));
}

describe('preferred languages', () => {
  it('resolve request > profile > instance, as 639-2/B', () => {
    expect(resolvePreferredLanguages({ instance: 'eng' })).toEqual(['eng']);
    expect(resolvePreferredLanguages({ profile: ['fra'], instance: 'eng' })).toEqual(['fre']);
    expect(
      resolvePreferredLanguages({
        request: ['deu', 'ita', 'ger'],
        profile: ['fre'],
        instance: 'eng',
      }),
    ).toEqual(['ger', 'ita']);
    expect(resolvePreferredLanguages({ request: [], instance: 'spa' })).toEqual(['spa']);
  });

  it('pick the audio track: wanted order, default-marked first, nothing to pick with one track', () => {
    const audio = [
      { index: 0, lang: 'eng', default: false },
      { index: 1, lang: 'ita', default: false },
      { index: 2, lang: 'ita', default: true },
      { index: 3, default: false },
    ];
    expect(chooseAudioTrack(audio, ['ita', 'eng'])).toBe(2);
    expect(chooseAudioTrack(audio, ['jpn', 'eng'])).toBe(0);
    expect(chooseAudioTrack(audio, ['jpn'])).toBeUndefined();
    expect(chooseAudioTrack([{ index: 0, lang: 'ita', default: true }], ['ita'])).toBeUndefined();
  });

  it('only the request’s own list and preferBingeGroup change an auto session’s identity', () => {
    const base = {
      key: 'room:1',
      item: MOVIE,
      source: { auto: true as const },
      delivery: 'auto' as const,
      quality: undefined,
    };
    const plain = sessionIdentity(base);
    // Unchanged encoding without the new fields (identities stored before them still match).
    expect(sessionIdentity({ ...base, preferredLanguages: undefined })).toBe(plain);
    expect(sessionIdentity({ ...base, preferredLanguages: ['ita'] })).not.toBe(plain);
    expect(
      sessionIdentity({ ...base, source: { auto: true, preferBingeGroup: 'torrentio|x' } }),
    ).not.toBe(plain);
    // A picked source plays what it plays: languages don't split it.
    const picked = { ...base, source: { key: 'k' } };
    expect(sessionIdentity({ ...picked, preferredLanguages: ['ita'] })).toBe(
      sessionIdentity(picked),
    );
  });
});

describe('session tracks and audioTrack (engine probe)', () => {
  it('lists audio and text subtitle tracks in rendition order; audioLanguage picks the start track', async () => {
    const r = await rig();
    r.fake.setProbe('https://media.example/multi.mkv', 'multi-language');
    const key = r.list(httpStream('multi'));
    const session = await ready(r, { item: MOVIE, source: { key }, audioLanguage: 'ita' });
    expect(session.status).toBe('ready');
    expect(session.tracks).toEqual({
      audio: [
        { index: 0, lang: 'eng', codec: 'eac3', channels: 6, default: true },
        { index: 1, lang: 'ita', codec: 'ac3', channels: 6, default: false },
        { index: 2, lang: 'deu', codec: 'aac', channels: 2, default: false },
      ],
      // The PGS track has no rendition, so the first text track is sub0.
      subtitles: [
        { index: 0, lang: 'ita', codec: 'subrip', default: false },
        { index: 1, lang: 'eng', codec: 'ass', default: false },
      ],
    });
    expect(session.audioTrack).toBe(1);
    // The indexes are the master's renditions.
    const handle = { engineId: 'home', sid: must(r.fake.sessions.keys().next().value) };
    const master = await (await r.module.fetchMedia(handle, 'master.m3u8')).text();
    expect(master).toContain(
      'LANGUAGE="ita",NAME="ita",DEFAULT=NO,AUTOSELECT=NO,URI="audio1.m3u8"',
    );
    expect(master).toContain(
      'LANGUAGE="ita",NAME="ita",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="sub0.m3u8"',
    );
  });

  it('falls back to the preferred languages (639-2/T matched as /B), then the instance default', async () => {
    const r = await rig({ MULTITAP_SELECTION_PREFERRED_LANGUAGE: 'ita' });
    r.fake.setProbe('https://media.example/multi.mkv', 'multi-language');
    const key = r.list(httpStream('multi'));
    const german = await ready(r, {
      item: MOVIE,
      source: { key },
      audioLanguage: 'jpn',
      preferredLanguage: ['ger', 'eng'],
    });
    expect(german.audioTrack).toBe(2);
    const instance = await ready(r, { item: MOVIE, source: { key } });
    expect(instance.audioTrack).toBe(1);
  });

  it('has no audioTrack for a single audio track, and keeps the tracks across a restart', async () => {
    const r = await rig();
    const key = r.list(httpStream('single'));
    const session = await ready(r, { item: MOVIE, source: { key }, audioLanguage: 'eng' });
    expect(session.tracks?.audio).toEqual([
      { index: 0, lang: 'eng', codec: 'aac', channels: 2, default: true },
    ]);
    expect(session.audioTrack).toBeUndefined();
    const record = must(await r.repo.get(session.id));
    expect(record.tracks).toEqual(session.tracks);
  });

  it('rejects malformed language codes on POST /v1/sessions', async () => {
    const r = await rig();
    const key = await r.keyFor('client');
    const post = (body: unknown) =>
      r.app.request('/v1/sessions', {
        method: 'POST',
        headers: { ...bearer(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const candidate = r.list(httpStream('good'));
    expect(
      (await post({ item: MOVIE, source: { key: candidate }, audioLanguage: 'it' })).status,
    ).toBe(400);
    expect(
      (await post({ item: MOVIE, source: { auto: true }, preferredLanguage: ['ITA'] })).status,
    ).toBe(400);
    const ok = await post({
      item: MOVIE,
      source: { key: candidate },
      audioLanguage: 'ita',
      preferredLanguage: ['ita', 'eng'],
    });
    expect(ok.status).toBe(201);
    PlaybackSessionSchema.parse(await ok.json());
  });
});

// ---- bingeGroup auto-next over the real torrentio-rd fixture ----------------------

const SERIES = 'tt0944947';
const episode = (n: number) => ({
  type: 'series',
  id: SERIES,
  videoId: `${SERIES}:1:${String(n)}`,
});

/** Episode 2's answer: episode 1's streams as the same releases (bingeGroups) would list them. */
function nextEpisodeStreams(): unknown {
  const body = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'torrentio-rd', `stream-series-${SERIES}_1_1.json`), 'utf8'),
  ) as { streams: Record<string, unknown>[] };
  return {
    streams: body.streams.map(
      (s) =>
        JSON.parse(
          JSON.stringify(s)
            .replaceAll('S01E01', 'S01E02')
            .replaceAll('S01e01', 'S01e02')
            .replace(/redacted\/(\d+)/, (_m, n: string) => `redacted/${String(Number(n) + 1000)}`),
        ) as unknown,
    ),
  };
}

async function bingeRig() {
  const r = await rig();
  const addon = await startFakeAddon({
    fixture: 'torrentio-rd',
    routes: { [`stream/series/${SERIES}:1:2`]: nextEpisodeStreams() },
  });
  addons.push(addon);
  await r.addons.collection.add(addon.manifestUrl);
  // The rig's service ranks a fixed list; this one ranks the real source list.
  const service = new SessionService({
    repo: r.repo,
    engines: r.module,
    getEngine: (id) => getEngine(r.db, id),
    defaultEngine: () => defaultEngineId(r.db, r.config.selection.defaultEngine),
    streams: r.streams,
    autoSources: autoSourcesFor(r.appDeps),
    config: r.config,
    clock: r.clock,
    // Its own ids: the rig's service and module share theirs.
    ids: {
      ...sequentialIds(),
      playbackSession: (() => {
        let n = 0;
        return () => `ps_B${String((n += 1)).padStart(21, '0')}`;
      })(),
    },
    logger: r.log.logger,
  });
  services.push(service);
  return { r, service };
}

describe('bingeGroup auto-next', () => {
  it("keeps the previous episode's release when the request passes its bingeGroup", async () => {
    const { r, service } = await bingeRig();

    // Without a preference, auto-select plays the best-ranked release.
    const best = await ready(r, { item: episode(1), source: { auto: true } }, service);
    expect(best.status).toBe('ready');
    const candidates = must(best.candidates);
    const top = must(candidates[0]);
    expect(best.chosen).toBe(top.key);
    expect(best.bingeGroup).toBe(top.bingeGroup);

    // Episode 1 on a lower-ranked release (the person picked it, or an earlier preference).
    const lower = must(candidates.at(-1));
    const first = await ready(
      r,
      { item: episode(1), source: { auto: true, preferBingeGroup: must(lower.bingeGroup) } },
      service,
    );
    expect(first.bingeGroup).toBe(lower.bingeGroup);
    expect(first.chosen).toBe(lower.key);

    // Episode 2 with the session's bingeGroup: the same release, not the best-ranked one.
    const next = await ready(
      r,
      { item: episode(2), source: { auto: true, preferBingeGroup: must(first.bingeGroup) } },
      service,
    );
    expect(next.status).toBe('ready');
    expect(next.bingeGroup).toBe(first.bingeGroup);
    const chosen = must(must(next.candidates).find((c) => c.key === next.chosen));
    expect(chosen.bingeGroup).toBe(first.bingeGroup);
    expect(chosen.key).not.toBe(lower.key); // episode 2's stream, not episode 1's

    // Without it, episode 2 goes back to the best-ranked release.
    const plain = await ready(r, { item: episode(2), source: { auto: true } }, service);
    expect(plain.bingeGroup).toBe(top.bingeGroup);
  });

  it('falls back to the normal ranking when no candidate has the bingeGroup', async () => {
    const { r, service } = await bingeRig();
    const session = await ready(
      r,
      { item: episode(2), source: { auto: true, preferBingeGroup: 'other|release' } },
      service,
    );
    expect(session.status).toBe('ready');
    expect(session.chosen).toBe(must(session.candidates)[0]?.key);
  });

  it('GET /v1/streams takes preferredLanguage and preferBingeGroup', async () => {
    const { r } = await bingeRig();
    const key = await r.keyFor('client');
    const get = async (query: string) => {
      const res = await r.app.request(
        `/v1/streams/series/${SERIES}:1:1?sort=rank&highRes=off${query}`,
        { headers: bearer(key) },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { candidates: PlaybackSession['candidates'] }).candidates ?? [];
    };
    const plain = await get('');
    // The Italian/English BDMux release: a match for the default (eng) …
    const bdmux = (list: typeof plain) =>
      must(list.find((c) => c.parsed.languages?.includes('ita')));
    const french = await get('&preferredLanguage=fre');
    expect(bdmux(plain).score - bdmux(french).score).toBe(
      DEFAULT_RANKING_SETTINGS.language.matchBonus +
        DEFAULT_RANKING_SETTINGS.language.mismatchPenalty,
    );
    // … a secondary match when Italian is second.
    const secondary = await get('&preferredLanguage=fra,ita');
    expect(bdmux(plain).score - bdmux(secondary).score).toBe(
      DEFAULT_RANKING_SETTINGS.language.matchBonus -
        DEFAULT_RANKING_SETTINGS.language.secondaryMatchBonus,
    );

    const lowest = must(plain.filter((c) => c.playable).at(-1));
    const preferred = await get(`&preferBingeGroup=${encodeURIComponent(must(lowest.bingeGroup))}`);
    expect(preferred[0]?.key).toBe(lowest.key);

    const bad = await r.app.request(`/v1/streams/series/${SERIES}:1:1?preferredLanguage=it`, {
      headers: bearer(key),
    });
    expect(bad.status).toBe(400);
  });
});
