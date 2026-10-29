/**
 * The library rules (src/library/), with stremio-core's own test cases where
 * they exist: `stremio-watched-bitfield/src/*.rs`, `types/resource/meta_item.rs`
 * (`next_video`), `unit_tests/serde/library_item_state.rs` and
 * `unit_tests/player/mark_video_as_watched.rs`.
 */
import type { LibraryItem, MetaVideo } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import {
  addToLibrary,
  advanceToVideo,
  continueWatching,
  CREDITS_THRESHOLD_COEF,
  eqNoMtime,
  isInContinueWatching,
  itemStateUpdate,
  libraryItemStateUpdate,
  markAsWatched,
  markSeasonWatched,
  markVideoWatched,
  markVideoAsWatched,
  newLibraryItem,
  nextVideo,
  progress,
  reconcileSeriesResumeAfterWatchedChange,
  removeFromLibrary,
  rewind,
  pushToLibraryDue,
  seek,
  timeChanged,
  videoToPlay,
  WATCHED_THRESHOLD_COEF,
  watchedBitfield,
  type LibraryMeta,
} from '../src/library/rules.ts';
import { BitField8, parseWatchedField, WatchedBitField } from '../src/library/watched-bitfield.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 3_600_000;

describe('watched bitfield (stremio-watched-bitfield)', () => {
  it('BitField8 decodes and encodes like the crate (test_de_serialize, parse_length)', () => {
    const bf = BitField8.decode('eJyTZwAAAEAAIA==');
    expect(bf.length).toBe(16);
    expect([...bf.values]).toEqual([31, 0]);
    expect(bf.encode()).toBe('eJyTZwAAAEAAIA==');
    expect(BitField8.decode('eJyTZwAAAEAAIA==', 9).length).toBe(9);
    expect(new BitField8(9, Uint8Array.from([31, 0])).encode()).toBe('eJyTZwAAAEAAIA==');
  });

  it('new_uses_bit_length', () => {
    const bf = new BitField8(20);
    expect(bf.length).toBe(20);
    bf.set(15, true);
    expect(bf.lastIndexOf(true)).toBe(15);
  });

  it('parse_and_modify', () => {
    const videos = Array.from({ length: 9 }, (_, i) => `tt2934286:1:${String(i + 1)}`);
    const watched = 'tt2934286:1:5:5:eJyTZwAAAEAAIA==';
    const wb = WatchedBitField.constructAndResize(watched, videos);
    expect(wb.getVideo('tt2934286:1:5')).toBe(true);
    expect(wb.getVideo('tt2934286:1:6')).toBe(false);
    expect(wb.toString()).toBe(watched);
    wb.setVideo('tt2934286:1:6', true);
    expect(wb.getVideo('tt2934286:1:6')).toBe(true);
  });

  it('construct_from_array round-trips alternating marks', () => {
    const videoIds = Array.from({ length: 499 }, (_, i) => `tt2934286:1:${String(i + 1)}`);
    const wb = WatchedBitField.constructFromArray(Array<boolean>(500).fill(false), videoIds);
    videoIds.forEach((id, i) => {
      expect(wb.get(i)).toBe(false);
      expect(wb.getVideo(id)).toBe(false);
    });
    videoIds.forEach((_, i) => {
      wb.set(i, i % 2 === 0);
    });
    const wb2 = WatchedBitField.constructAndResize(wb.toString(), videoIds);
    videoIds.forEach((id, i) => {
      expect(wb2.get(i)).toBe(i % 2 === 0);
      expect(wb2.getVideo(id)).toBe(i % 2 === 0);
    });
  });

  it('to_string_empty and deserialize_empty', () => {
    expect(WatchedBitField.constructFromArray([], []).toString()).toBe('undefined:1:eJwDAAAAAAE=');
    const wb = WatchedBitField.constructAndResize('undefined:1:eJwDAAAAAAE=', []);
    expect(wb.bitfield.length).toBe(0);
    expect(wb.videoIds).toEqual([]);
  });

  it('test_watched_field_de_serialize: video ids with colons', () => {
    const field = parseWatchedField('tt7767422:3:8:24:eJz7//8/AAX9Av4=');
    expect(field.anchorVideo).toBe('tt7767422:3:8');
    expect(field.anchorLength).toBe(24);
    expect(field.bitfield.encode()).toBe('eJz7//8/AAX9Av4=');
  });

  it('watched_field_anchor_points_to_last_watched_video', () => {
    const videoIds = Array.from({ length: 20 }, (_, i) => `tt0:1:${String(i + 1)}`);
    const wb = WatchedBitField.constructFromArray([], videoIds);
    wb.setVideo('tt0:1:16', true);
    expect(wb.toString().startsWith('tt0:1:16:16:')).toBe(true);
  });

  it('realigns by the anchor when episodes are added before it', () => {
    const before = ['s1e1', 's1e2', 's1e3'];
    const wb = WatchedBitField.constructFromArray([true, true, false], before);
    const after = ['s0e1', ...before];
    const realigned = WatchedBitField.constructAndResize(wb.toString(), after);
    expect(after.map((id) => realigned.getVideo(id))).toEqual([false, true, true, false]);
    // An anchor no longer listed gives an empty field.
    const gone = WatchedBitField.constructAndResize(wb.toString(), ['x', 'y']);
    expect([gone.get(0), gone.get(1)]).toEqual([false, false]);
  });

  it('rejects malformed fields', () => {
    expect(() => parseWatchedField('a:b')).toThrow();
    expect(() => parseWatchedField('a:x:eJwDAAAAAAE=')).toThrow();
    expect(() => parseWatchedField('a:1:!!!!')).toThrow();
  });
});

const video = (id: string, season: number, episode: number, released?: string): MetaVideo => ({
  id,
  title: id,
  season,
  episode,
  ...(released === undefined ? {} : { released }),
});

function meta(videos: MetaVideo[], over: Partial<LibraryMeta> = {}): LibraryMeta {
  return {
    id: 'tt123456',
    type: 'series',
    name: 'Test Series',
    posterShape: 'poster',
    behaviorHints: { isLive: false, hasScheduledVideos: false },
    videos,
    ...over,
  };
}

describe('next_video (meta_item.rs)', () => {
  const m = meta([
    video('s0e1', 0, 1),
    video('s0e2', 0, 2),
    video('s1e1', 1, 1),
    video('s1e2', 1, 2),
    video('s2e1', 2, 1),
    video('s0e3', 0, 3),
  ]);
  it.each([
    ['s0e1', 's0e2'],
    ['s0e2', 's1e1'],
    ['s1e1', 's1e2'],
    ['s1e2', 's2e1'],
    ['s2e1', undefined], // should not cross into season 0 specials
    ['s0e3', undefined],
    ['missing', undefined],
  ])('after %s comes %s', (current, expected) => {
    expect(nextVideo(m, current, NOW)?.id).toBe(expected);
  });

  it('next_video_excludes_unreleased_video', () => {
    const unreleased = meta([video('s1e1', 1, 1), video('s1e2', 1, 2, iso(NOW + 24 * HOUR))]);
    expect(nextVideo(unreleased, 's1e1', NOW)).toBeUndefined();
    const released = meta([video('s1e1', 1, 1), video('s1e2', 1, 2, iso(NOW))]);
    expect(nextVideo(released, 's1e1', NOW)?.id).toBe('s1e2');
  });

  it('live items do not advance', () => {
    const live = meta([video('a', 1, 1), video('b', 1, 2)], { type: 'tv' });
    expect(nextVideo(live, 'a', NOW)).toBeUndefined();
  });
});

function iso(ms: number) {
  return new Date(ms).toISOString();
}

/** `make_library_item` from unit_tests/player/mark_video_as_watched.rs. */
function libraryItem(
  videoId: string | null,
  over: Partial<LibraryItem['state']> = {},
): LibraryItem {
  return {
    _id: 'tt123456',
    name: 'Test Series',
    type: 'series',
    poster: null,
    posterShape: 'poster',
    removed: false,
    temp: false,
    _ctime: null,
    _mtime: iso(0),
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: videoId,
      watched: null,
      noNotif: false,
      ...over,
    },
    behaviorHints: {
      isLive: false,
      defaultVideoId: null,
      featuredVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

const s1 = meta([video('tt123456:1:1', 1, 1), video('tt123456:1:2', 1, 2)]);

describe('TimeChanged (player.rs)', () => {
  it('counts forward progress and flags watched past 70%', () => {
    const item = libraryItem('tt123456:1:1');
    const watched = watchedBitfield(item.state, s1.videos);
    const update = { videoId: 'tt123456:1:1', duration: HOUR };
    expect(timeChanged(item, { ...update, time: 0.6 * HOUR }, watched, NOW)).toBe(false);
    expect(item.state).toMatchObject({ timeWatched: 0.6 * HOUR, timeOffset: 0.6 * HOUR });
    // Exactly at the threshold is not past it.
    expect(
      timeChanged(item, { ...update, time: WATCHED_THRESHOLD_COEF * HOUR }, watched, NOW),
    ).toBe(false);
    expect(timeChanged(item, { ...update, time: 0.71 * HOUR }, watched, NOW)).toBe(true);
    expect(item.state).toMatchObject({ flaggedWatched: 1, timesWatched: 1, lastWatched: iso(NOW) });
    expect(watchedBitfield(item.state, s1.videos).getVideo('tt123456:1:1')).toBe(true);
    // Flagged once per video.
    expect(timeChanged(item, { ...update, time: 0.8 * HOUR }, watched, NOW)).toBe(false);
    expect(item.state.timesWatched).toBe(1);
  });

  it('time_changed_without_duration_does_not_flag_watched', () => {
    const item = libraryItem('tt123456:1:1');
    timeChanged(item, { videoId: 'tt123456:1:1', time: 600_000, duration: 0 }, undefined, NOW);
    expect(item.state.flaggedWatched).toBe(0);
    expect(item.state.timesWatched).toBe(0);
  });

  it('a backward position neither counts nor moves the offset; a seek does', () => {
    const item = libraryItem('tt123456:1:1', { timeOffset: 600_000, duration: HOUR });
    timeChanged(item, { videoId: 'tt123456:1:1', time: 300_000, duration: HOUR }, undefined, NOW);
    expect(item.state).toMatchObject({ timeOffset: 600_000, timeWatched: 0 });
    seek(item, 300_000, HOUR, NOW);
    expect(item.state).toMatchObject({ timeOffset: 300_000, timeWatched: 0 });
    timeChanged(item, { videoId: 'tt123456:1:1', time: 310_000, duration: HOUR }, undefined, NOW);
    expect(item.state).toMatchObject({ timeOffset: 310_000, timeWatched: 10_000 });
  });

  it('a new video moves time watched into the overall total', () => {
    const item = libraryItem('tt123456:1:1', {
      timeWatched: 500,
      overallTimeWatched: 700,
      flaggedWatched: 1,
      timeOffset: 1,
    });
    timeChanged(item, { videoId: 'tt123456:1:2', time: 1_000, duration: HOUR }, undefined, NOW);
    expect(item.state).toMatchObject({
      video_id: 'tt123456:1:2',
      timeWatched: 0,
      overallTimeWatched: 1_200,
      flaggedWatched: 0,
      timeOffset: 1_000,
    });
  });

  it.each([
    // temp, removed, watched → removed, temp
    [true, false, false, true, true],
    [true, false, true, false, true],
    [false, true, false, true, true],
    [false, false, false, false, false],
  ])('temp=%s removed=%s watched=%s → removed=%s temp=%s', (temp, removed, watched, r, t) => {
    const item = { ...libraryItem('v', { timesWatched: watched ? 1 : 0 }), temp, removed };
    timeChanged(item, { videoId: 'v', time: 1, duration: HOUR }, undefined, NOW);
    expect([item.removed, item.temp]).toEqual([r, t]);
  });

  it('live items always play the channel and are never flagged', () => {
    const item = { ...libraryItem(null), type: 'tv' };
    timeChanged(item, { videoId: 'other', time: HOUR, duration: HOUR }, undefined, NOW);
    expect(item.state.video_id).toBe('tt123456');
    expect(item.state.flaggedWatched).toBe(0);
  });
});

describe('unload and load (item_state_update, library_item_state_update)', () => {
  it('past the credits moves on to the next episode with offset 1', () => {
    const item = libraryItem('tt123456:1:1', {
      timeOffset: CREDITS_THRESHOLD_COEF * HOUR + 1,
      duration: HOUR,
      timeWatched: 3_000,
    });
    itemStateUpdate(item, nextVideo(s1, 'tt123456:1:1', NOW));
    expect(item.state).toMatchObject({
      video_id: 'tt123456:1:2',
      timeOffset: 1,
      timeWatched: 0,
      overallTimeWatched: 3_000,
    });
    expect(isInContinueWatching(item)).toBe(true);
  });

  it('mark_last_episode_as_watched_does_not_advance: the last episode clears the offset', () => {
    const item = libraryItem('tt123456:1:2', { timeOffset: 0.95 * HOUR, duration: HOUR });
    itemStateUpdate(item, nextVideo(s1, 'tt123456:1:2', NOW));
    expect(item.state).toMatchObject({ video_id: 'tt123456:1:2', timeOffset: 0 });
    expect(isInContinueWatching(item)).toBe(false);
  });

  it('before the credits keeps the position', () => {
    const item = libraryItem('tt123456:1:1', { timeOffset: 0.5 * HOUR, duration: HOUR });
    itemStateUpdate(item, nextVideo(s1, 'tt123456:1:1', NOW));
    expect(item.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: 0.5 * HOUR });
  });

  it('live items reset to the channel', () => {
    const item = { ...libraryItem('x', { timeOffset: 5 }), type: 'tv' };
    itemStateUpdate(item, undefined);
    expect(item.state).toMatchObject({ video_id: 'tt123456', timeOffset: 0 });
  });

  it.each([
    ['tt123456:1:1', 'tt123456:1:1', true, false, 500],
    ['tt123456:1:1', 'tt123456:1:2', true, true, 1],
    ['tt123456:1:1', 'tt123456:1:2', false, true, 0],
    [null, 'tt123456:1:2', true, false, 500],
  ])(
    'stored %s, playing %s, next %s → push %s, offset %s',
    (stored, playing, hasNext, push, offset) => {
      const item = libraryItem(stored, { timeOffset: 500 });
      expect(libraryItemStateUpdate(item, hasNext ? { id: 'n' } : undefined, playing)).toBe(push);
      expect(item.state.timeOffset).toBe(offset);
    },
  );
});

describe('LibraryItem methods (library_item.rs)', () => {
  it('a new item from meta is removed and temp until watched', () => {
    const item = newLibraryItem({ ...s1, poster: 'https://img.example.invalid/p.jpg' }, NOW);
    expect(item).toMatchObject({
      _id: 'tt123456',
      removed: true,
      temp: true,
      _ctime: iso(NOW),
      poster: 'https://img.example.invalid/p.jpg',
      state: { lastWatched: iso(NOW), video_id: null, watched: null },
      behaviorHints: { isLive: false, defaultVideoId: null },
    });
    expect(newLibraryItem({ ...s1, type: 'tv' }, NOW).behaviorHints.isLive).toBe(true);
  });

  it.each([
    ['series', false, false, 1, true],
    ['series', true, true, 1, true],
    ['series', true, false, 1, false],
    ['other', false, false, 1, false],
    ['series', false, false, 0, false],
  ])(
    'is_in_continue_watching(type=%s removed=%s temp=%s offset=%s) = %s',
    (type, removed, temp, offset, cw) => {
      const item = { ...libraryItem('v', { timeOffset: offset }), type, removed, temp };
      expect(isInContinueWatching(item)).toBe(cw);
    },
  );

  it('progress', () => {
    expect(progress(libraryItem('v', { timeOffset: 250, duration: 1000 }))).toBe(25);
    expect(progress(libraryItem('v', { timeOffset: 250, duration: 0 }))).toBe(0);
  });

  it('mark_as_watched', () => {
    const item = libraryItem('v', { timeOffset: 900, timesWatched: 2 });
    markAsWatched(item, true, NOW);
    expect(item.state).toMatchObject({ timesWatched: 3, lastWatched: iso(NOW), timeOffset: 0 });
    markAsWatched(item, false, NOW);
    expect(item.state.timesWatched).toBe(0);
  });

  it('mark_video_as_watched: last_watched moves up to a later release', () => {
    const item = libraryItem('tt123456:1:1', { lastWatched: iso(NOW - HOUR) });
    const watched = watchedBitfield(item.state, s1.videos);
    markVideoAsWatched(item, watched, { id: 'tt123456:1:2', released: iso(NOW) }, true);
    expect(item.state.lastWatched).toBe(iso(NOW));
    expect(watchedBitfield(item.state, s1.videos).getVideo('tt123456:1:2')).toBe(true);
    markVideoAsWatched(item, watched, { id: 'tt123456:1:1', released: iso(0) }, true);
    expect(item.state.lastWatched).toBe(iso(NOW));
  });

  it('advance_to_video', () => {
    const item = libraryItem('a', { timeWatched: 5, overallTimeWatched: 10, flaggedWatched: 1 });
    advanceToVideo(item, 'b');
    expect(item.state).toMatchObject({
      video_id: 'b',
      timeWatched: 0,
      overallTimeWatched: 15,
      flaggedWatched: 0,
      timeOffset: 1,
    });
  });

  it('watched_bitfield orders specials first and survives a bad field', () => {
    const videos = [video('s1e1', 1, 1), video('s0e1', 0, 1)];
    const wb = watchedBitfield(libraryItem(null).state, videos);
    expect(wb.videoIds).toEqual(['s0e1', 's1e1']);
    expect(watchedBitfield(libraryItem(null, { watched: 'garbage' }).state, videos).get(0)).toBe(
      false,
    );
  });

  it('serde fixture (unit_tests/serde/library_item_state.rs)', () => {
    const videos = Array.from({ length: 9 }, (_, i) =>
      video(`tt2934286:1:${String(i + 1)}`, 1, i + 1),
    );
    const wb = watchedBitfield(
      libraryItem(null, { watched: 'tt2934286:1:5:5:eJyTZwAAAEAAIA==' }).state,
      videos,
    );
    expect([1, 2, 3, 4, 5, 6].map((e) => wb.getVideo(`tt2934286:1:${String(e)}`))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('eq_no_mtime ignores only the mtime', () => {
    const a = libraryItem('v');
    expect(eqNoMtime(a, { ...a, _mtime: iso(NOW) })).toBe(true);
    expect(eqNoMtime(a, { ...a, name: 'x' })).toBe(false);
  });

  it('push_to_library every 90 s', () => {
    expect(pushToLibraryDue(0, NOW)).toBe(true);
    expect(pushToLibraryDue(NOW, NOW + 89_999)).toBe(false);
    expect(pushToLibraryDue(NOW, NOW + 90_000)).toBe(true);
  });
});

describe('continue watching and the video to play', () => {
  it('lists items with an offset, newest first, without live ones', () => {
    const at = (ms: number, over: Partial<LibraryItem> = {}, offset = 1): LibraryItem => ({
      ...libraryItem('v', { timeOffset: offset }),
      _id: `i${String(ms)}`,
      _mtime: iso(ms),
      ...over,
    });
    const items = [at(1), at(3), at(2, { type: 'tv' }), at(4, {}, 0), at(5)];
    expect(continueWatching(items).map((i) => i._id)).toEqual(['i5', 'i3', 'i1']);
    const many = Array.from({ length: 120 }, (_, i) => at(i));
    expect(continueWatching(many)).toHaveLength(100);
  });

  it.each([
    ['no item yet: the first video', null, 0, 'tt123456:1:1'],
    ['resume the current video', 'tt123456:1:1', 5, 'tt123456:1:1'],
    ['finished one: the next', 'tt123456:1:1', 0, 'tt123456:1:2'],
    ['after the last episode: none', 'tt123456:1:2', 0, null],
  ])('%s', (_, current, offset, expected) => {
    const item = current === null ? undefined : libraryItem(current, { timeOffset: offset });
    expect(videoToPlay(s1, item, NOW)).toBe(expected);
  });

  it('none for movies and live items; the default video first', () => {
    expect(videoToPlay(meta([], { type: 'movie' }), undefined, NOW)).toBeNull();
    expect(videoToPlay({ ...s1, type: 'tv' }, undefined, NOW)).toBeNull();
    const withDefault = {
      ...s1,
      behaviorHints: { isLive: false, hasScheduledVideos: false, defaultVideoId: 'tt123456:1:2' },
    };
    expect(videoToPlay(withDefault, undefined, NOW)).toBe('tt123456:1:2');
  });
});

describe('library writes (ctx/update_library.rs, meta_details.rs)', () => {
  const PREV = 40 * 60 * 1000;
  const PREV_OVERALL = 5 * 60 * 1000;
  const playing = (videoId: string): LibraryItem =>
    libraryItem(videoId, {
      timeOffset: PREV,
      timeWatched: PREV,
      overallTimeWatched: PREV_OVERALL,
      flaggedWatched: 1,
      duration: HOUR,
    });
  const vid = (season: number, episode: number, released?: string) =>
    video(`tt123456:${String(season)}:${String(episode)}`, season, episode, released);
  const twoSeasons = meta([vid(1, 1), vid(1, 2), vid(2, 1)]);

  it('add_to_library: in the library and not temp; remove keeps progress (actionctx_*)', () => {
    const item = newLibraryItem(s1, NOW);
    expect([item.removed, item.temp]).toEqual([true, true]);
    addToLibrary(item);
    expect([item.removed, item.temp]).toEqual([false, false]);
    const watching = { ...playing('tt123456:1:1'), temp: true };
    removeFromLibrary(watching);
    expect([watching.removed, watching.temp]).toEqual([true, false]);
    expect(watching.state.timeOffset).toBe(PREV);
    expect(isInContinueWatching(watching)).toBe(false);
    addToLibrary(watching);
    expect(isInContinueWatching(watching)).toBe(true);
  });

  it('rewind clears only the offset (actionctx_rewindlibraryitem)', () => {
    const item = playing('tt123456:1:1');
    rewind(item);
    expect(item.state).toMatchObject({
      timeOffset: 0,
      timeWatched: PREV,
      video_id: 'tt123456:1:1',
    });
  });

  it('mark_video_as_watched_advances_video_id', () => {
    const item = playing('tt123456:1:1');
    markVideoWatched(item, s1, { id: 'tt123456:1:1' }, true, NOW);
    expect(item.state).toMatchObject({
      video_id: 'tt123456:1:2',
      timeOffset: 1,
      timeWatched: 0,
      flaggedWatched: 0,
      overallTimeWatched: PREV_OVERALL + PREV,
    });
    expect(watchedBitfield(item.state, s1.videos).getVideo('tt123456:1:1')).toBe(true);
  });

  it('mark_video_as_watched_does_not_advance_to_unreleased_video', () => {
    const unreleased = meta([vid(1, 1), vid(1, 2, iso(NOW + 24 * HOUR))]);
    const item = playing('tt123456:1:1');
    markVideoWatched(item, unreleased, { id: 'tt123456:1:1' }, true, NOW);
    expect(item.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: 0 });
  });

  it('mark_last_video_as_watched_clears_continue_watching_progress', () => {
    const item = playing('tt123456:1:2');
    markVideoWatched(item, s1, { id: 'tt123456:1:2' }, true, NOW);
    expect(item.state).toMatchObject({ video_id: 'tt123456:1:2', timeOffset: 0 });
  });

  it('marking another video, or unwatched, keeps the resume pointer', () => {
    const other = playing('tt123456:1:1');
    markVideoWatched(other, s1, { id: 'tt123456:1:2' }, true, NOW);
    expect(other.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: PREV });
    const unmark = playing('tt123456:1:1');
    markVideoWatched(unmark, s1, { id: 'tt123456:1:1' }, false, NOW);
    expect(unmark.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: PREV });
    expect(watchedBitfield(unmark.state, s1.videos).getVideo('tt123456:1:1')).toBe(false);
  });

  it('mark_season_as_watched_clears_continue_watching_when_all_released_episodes_are_watched', () => {
    const item = playing('tt123456:1:1');
    expect(markSeasonWatched(item, s1, 1, true, NOW)).toBe(true);
    expect(item.state).toMatchObject({ timeOffset: 0, video_id: 'tt123456:1:1' });
  });

  it('mark_season_as_watched_advances_to_next_released_unwatched_season', () => {
    const item = playing('tt123456:1:1');
    markSeasonWatched(item, twoSeasons, 1, true, NOW);
    expect(item.state).toMatchObject({
      video_id: 'tt123456:2:1',
      timeOffset: 1,
      timeWatched: 0,
      flaggedWatched: 0,
      overallTimeWatched: PREV_OVERALL + PREV,
    });
  });

  it.each([
    ['tt123456:2:1', 1],
    ['tt123456:1:1', 2],
  ])(
    'mark_other_season_as_watched_preserves_resume_progress (%s, season %i)',
    (videoId, season) => {
      const item = playing(videoId);
      const bits = watchedBitfield(item.state, twoSeasons.videos);
      bits.setVideo(videoId, true);
      item.state.watched = bits.toString();
      markSeasonWatched(item, twoSeasons, season, true, NOW);
      expect(item.state).toMatchObject({ video_id: videoId, timeOffset: PREV, timeWatched: PREV });
      const after = watchedBitfield(item.state, twoSeasons.videos);
      for (const v of twoSeasons.videos.filter((x) => x.season === season)) {
        expect(after.getVideo(v.id)).toBe(true);
      }
    },
  );

  it('mark_season_as_unwatched_preserves_existing_resume_progress', () => {
    const item = playing('tt123456:1:1');
    markSeasonWatched(item, s1, 1, false, NOW);
    expect(item.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: PREV });
  });

  it('a season without videos changes nothing', () => {
    const item = playing('tt123456:1:1');
    const before = structuredClone(item);
    expect(markSeasonWatched(item, s1, 9, true, NOW)).toBe(false);
    expect(item).toEqual(before);
  });

  it('reconcile skips unreleased episodes and stops at the season-0 boundary', () => {
    const watchedAll = (m: LibraryMeta, ids: string[]) => {
      const item = playing(ids[0] ?? '');
      const bits = watchedBitfield(item.state, m.videos);
      for (const id of ids) bits.setVideo(id, true);
      return { item, bits };
    };
    const m = meta([vid(1, 1), vid(1, 2), vid(2, 1, iso(NOW + HOUR))]);
    const a = watchedAll(m, ['tt123456:1:1', 'tt123456:1:2']);
    reconcileSeriesResumeAfterWatchedChange(a.item, 1, a.bits, m, NOW);
    expect(a.item.state).toMatchObject({ video_id: 'tt123456:1:1', timeOffset: 0 });
    // Past the last regular season the next video would be a special: none.
    const specials = meta([vid(1, 1), video('sp', 0, 1)]);
    const b = watchedAll(specials, ['tt123456:1:1']);
    reconcileSeriesResumeAfterWatchedChange(b.item, 1, b.bits, specials, NOW);
    expect(b.item.state.timeOffset).toBe(0);
  });

  it('MetaItemMarkAsWatched on a new item creates it temp and removed (mark_meta_item_as_watched.rs)', () => {
    const item = newLibraryItem(s1, NOW);
    markAsWatched(item, true, NOW);
    expect(item).toMatchObject({ removed: true, temp: true, state: { timesWatched: 1 } });
    expect(item.state.lastWatched).toBe(iso(NOW));
  });
});
