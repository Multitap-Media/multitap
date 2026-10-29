/**
 * Review PoCs (core-review/bugs-library): the library service's per-profile
 * player model against stremio-core's per-device player. `it.fails` = the bug
 * is present; each assertion states the expected behaviour.
 */
import type { MetaDetail } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { sequentialIds } from '../../../src/lib/ids.ts';
import { defaultState, watchedBitfield } from '../../../src/library/rules.ts';
import { LibraryService } from '../../../src/library/service.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from '../../helpers.ts';

const MIN = 60_000;
const DURATION = 45 * MIN;

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
const ep = (n: number) => `tt0903747:1:${String(n)}`;

async function setup() {
  const db = await migratedMemoryDb();
  const clock = manualClock();
  const library = new LibraryService({
    db,
    clock,
    logger: memoryLogger().logger,
    meta: (type, id) =>
      Promise.resolve(type === SERIES.type && id === SERIES.id ? SERIES : undefined),
    ids: sequentialIds(),
  });
  const profile = await library.createProfile('Household');
  const item = { type: 'series', id: SERIES.id };
  return { db, clock, library, profileId: profile.id, item };
}

describe('library playback model (bugs-library PoCs)', () => {
  it.fails(
    'two devices of one profile playing different episodes both count as watched',
    async () => {
      const { clock, library, profileId, item } = await setup();
      // Device A plays episode 1 to the end in 30 s steps; device B plays
      // episode 2 at the same time (a second TV, or a phone in another room).
      for (let t = 0; t <= DURATION; t += 30_000) {
        clock.advance(30_000);
        await library.report(profileId, { item, videoId: ep(1), time: t, duration: DURATION });
        await library.report(profileId, { item, videoId: ep(2), time: t, duration: DURATION });
      }
      await library.report(profileId, {
        item,
        videoId: ep(1),
        time: DURATION,
        duration: DURATION,
        event: 'ended',
      });
      const [stored] = (await library.library(profileId)) ?? [];
      // stremio-core (one player per device) marks both episodes watched, once each.
      // Here: episode 1 is never marked, and timesWatched/overallTimeWatched
      // inflate (9 and ~12.9 h for 2 x 45 min) as each unload past the credits
      // advances to episode 2, whose next report then re-crosses the threshold.
      const state = stored?.state;
      expect(state?.timesWatched).toBeLessThanOrEqual(2);
      expect(state?.overallTimeWatched ?? 0).toBeLessThanOrEqual(2 * DURATION + MIN);
      const watched = watchedBitfield(state ?? defaultState(), SERIES.videos);
      expect(watched.getVideo(ep(1))).toBe(true);
    },
  );

  it.fails(
    'a playback that is never stopped (tab closed) still moves on past the credits',
    async () => {
      const { clock, library, profileId, item } = await setup();
      for (let t = 0; t <= 0.95 * DURATION; t += 30_000) {
        clock.advance(30_000);
        await library.report(profileId, { item, videoId: ep(1), time: t, duration: DURATION });
      }
      // The client goes away without `stop` or `ended`; a day passes.
      clock.advance(24 * 60 * MIN);
      const next = await library.next(profileId, 'series', SERIES.id);
      // stremio-core unloads the player when it closes: past 90 %, episode 2 is next.
      expect(next.kind === 'ok' ? next.videoId : undefined).toBe(ep(2));
    },
  );

  it.fails('marking the playing episode watched survives the next progress report', async () => {
    const { clock, library, profileId, item } = await setup();
    for (let t = 0; t <= 20 * MIN; t += 30_000) {
      clock.advance(30_000);
      await library.report(profileId, { item, videoId: ep(1), time: t, duration: DURATION });
    }
    // The user marks the episode watched from the player, keeps it running a
    // little, then stops.
    await library.markVideoWatched(profileId, 'series', SERIES.id, ep(1), true);
    clock.advance(30_000);
    await library.report(profileId, { item, videoId: ep(1), time: 20.5 * MIN, duration: DURATION });
    clock.advance(30_000);
    await library.report(profileId, {
      item,
      videoId: ep(1),
      time: 21 * MIN,
      duration: DURATION,
      event: 'stop',
    });
    const next = await library.next(profileId, 'series', SERIES.id);
    // stremio-core defers the advance to unload (`marked_video_as_watched`), so
    // continue watching moves on to episode 2.
    expect(next.kind === 'ok' ? next.videoId : undefined).toBe(ep(2));
  });

  it.fails(
    'an addon hiccup when playback starts does not stop the episode being marked watched',
    async () => {
      const db = await migratedMemoryDb();
      const clock = manualClock();
      let calls = 0;
      const library = new LibraryService({
        db,
        clock,
        logger: memoryLogger().logger,
        // The first meta lookup fails (timeout, open circuit); later ones work.
        meta: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('timeout')) : Promise.resolve(SERIES);
        },
        ids: sequentialIds(),
      });
      const { id: profileId } = await library.createProfile('Solo');
      const item = { type: 'series', id: SERIES.id };
      for (let t = 0; t <= DURATION; t += 30_000) {
        clock.advance(30_000);
        await library.report(profileId, { item, videoId: ep(1), time: t, duration: DURATION });
      }
      await library.report(profileId, {
        item,
        videoId: ep(1),
        time: DURATION,
        duration: DURATION,
        event: 'ended',
      });
      const [stored] = (await library.library(profileId)) ?? [];
      expect(stored?.state.timesWatched).toBe(1);
      // The meta is never looked up again for this playback, so the bitfield
      // never gets episode 1 (stremio-core recomputes it when the meta loads).
      const watched = watchedBitfield(stored?.state ?? defaultState(), SERIES.videos);
      expect(watched.getVideo(ep(1))).toBe(true);
    },
  );
});
