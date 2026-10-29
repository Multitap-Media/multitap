/**
 * stremio-core's library rules, ported as pure functions (okf:architecture/library-and-profiles).
 *
 * Sources, all under `ref/stremio-core/src/`:
 * - `types/library/library_item.rs`: `LibraryItem`'s methods
 * - `models/player.rs`: `TimeChanged`, `Seek`, `item_state_update`,
 *   `library_item_state_update`, `library_item_update`, `push_to_library`
 * - `types/resource/meta_item.rs`: `next_video`
 * - `models/continue_watching_preview.rs`: the continue-watching list
 * - `models/ctx/update_library.rs`: `UpdateLibraryItem` (`eq_no_mtime`, mtime)
 *
 * Like stremio-core, the mutating functions change the item they are given;
 * callers clone first ({@link cloneItem}). Times are Unix milliseconds in, and
 * ISO strings in the item, as stremio-core serializes them.
 */
import { isDeepStrictEqual } from 'node:util';
import type {
  LibraryItem,
  LibraryItemBehaviorHints,
  LibraryItemState,
  MetaDetail,
  MetaVideo,
} from '@multitap/api';
import { WatchedBitField } from './watched-bitfield.ts';

/** `constants.rs`: watched once time watched passes this share of the duration. */
export const WATCHED_THRESHOLD_COEF = 0.7;
/** `constants.rs`: past this share of the duration, unloading moves on to the next video. */
export const CREDITS_THRESHOLD_COEF = 0.9;
/** `models/player.rs`: `PUSH_TO_LIBRARY_EVERY`. */
export const PUSH_TO_LIBRARY_EVERY_MS = 90_000;
/** `constants.rs`: `CATALOG_PREVIEW_SIZE`, the length of the continue-watching list. */
export const CONTINUE_WATCHING_SIZE = 100;

/** The meta fields the rules use: core-api's `MetaDetail`. */
export type LibraryMeta = Pick<
  MetaDetail,
  'id' | 'type' | 'name' | 'poster' | 'posterShape' | 'behaviorHints' | 'videos'
>;
/** A meta without videos: what a library item is created from. */
export type LibraryMetaPreview = Omit<LibraryMeta, 'videos'>;

const iso = (ms: number) => new Date(ms).toISOString();

export function cloneItem(item: LibraryItem): LibraryItem {
  return structuredClone(item);
}

/** `MetaItemBehaviorHints::is_live`. */
export function isLiveType(hints: { isLive?: boolean | undefined }, type: string): boolean {
  return hints.isLive === true || type === 'tv';
}

/** `LibraryItem::is_live`. */
export function isLive(item: LibraryItem): boolean {
  return isLiveType(item.behaviorHints, item.type);
}

/** `MetaItem::is_live`. */
export function isMetaLive(meta: LibraryMetaPreview): boolean {
  return isLiveType(meta.behaviorHints, meta.type);
}

export function defaultState(): LibraryItemState {
  return {
    lastWatched: null,
    timeWatched: 0,
    timeOffset: 0,
    overallTimeWatched: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    duration: 0,
    video_id: null,
    watched: null,
    noNotif: false,
  };
}

function hintsFromMeta(meta: LibraryMetaPreview): LibraryItemBehaviorHints {
  return {
    isLive: isMetaLive(meta),
    defaultVideoId: meta.behaviorHints.defaultVideoId ?? null,
    featuredVideoId: meta.behaviorHints.featuredVideoId ?? null,
    hasScheduledVideos: meta.behaviorHints.hasScheduledVideos,
  };
}

/** `From<(&MetaItemPreview, PhantomData<E>)>`: a new item, removed and temp until watched. */
export function newLibraryItem(meta: LibraryMetaPreview, now: number): LibraryItem {
  return {
    _id: meta.id,
    name: meta.name,
    type: meta.type,
    poster: meta.poster ?? null,
    posterShape: meta.posterShape,
    removed: true,
    temp: true,
    _ctime: iso(now),
    _mtime: iso(now),
    state: { ...defaultState(), lastWatched: iso(now) },
    behaviorHints: hintsFromMeta(meta),
  };
}

/** `From<(&MetaItemPreview, &LibraryItem)>`: the item with the meta's current name, poster and hints. */
export function refreshFromMeta(meta: LibraryMetaPreview, item: LibraryItem): LibraryItem {
  return {
    ...cloneItem(item),
    _id: meta.id,
    name: meta.name,
    type: meta.type,
    poster: meta.poster ?? null,
    posterShape: meta.posterShape,
    behaviorHints: hintsFromMeta(meta),
  };
}

/** `LibraryItem::is_in_continue_watching`. */
export function isInContinueWatching(item: LibraryItem): boolean {
  return item.type !== 'other' && (!item.removed || item.temp) && item.state.timeOffset > 0;
}

/** `LibraryItem::progress`: percent of the current video. */
export function progress(item: LibraryItem): number {
  const { timeOffset, duration } = item.state;
  return timeOffset > 0 && duration > 0 ? (timeOffset / duration) * 100 : 0;
}

/** `LibraryItem::watched`. */
export function isWatched(item: LibraryItem): boolean {
  return item.state.timesWatched > 0;
}

/** `LibraryItem::eq_no_mtime`. */
export function eqNoMtime(a: LibraryItem, b: LibraryItem): boolean {
  return isDeepStrictEqual({ ...a, _mtime: '' }, { ...b, _mtime: '' });
}

/** `LibraryItem::mark_as_watched`. */
export function markAsWatched(item: LibraryItem, watched: boolean, now: number): void {
  if (watched) {
    item.state.timesWatched += 1;
    item.state.lastWatched = iso(now);
    item.state.timeOffset = 0;
  } else {
    item.state.timesWatched = 0;
  }
}

/** The `last_watched` rule shared by `mark_video(s)_as_watched`. */
function lastWatchedAfterMarking(lastWatched: string | null, released: string | undefined) {
  if (lastWatched !== null && released !== undefined) {
    return Date.parse(lastWatched) < Date.parse(released) ? released : lastWatched;
  }
  if (lastWatched === null) return released ?? null;
  return lastWatched;
}

/** `LibraryItem::mark_video_as_watched`. */
export function markVideoAsWatched(
  item: LibraryItem,
  watched: WatchedBitField,
  video: Pick<MetaVideo, 'id' | 'released'>,
  isWatchedNow: boolean,
): void {
  const next = watched.clone();
  next.setVideo(video.id, isWatchedNow);
  item.state.watched = next.toString();
  if (isWatchedNow) {
    item.state.lastWatched = lastWatchedAfterMarking(item.state.lastWatched, video.released);
  }
}

/** `LibraryItem::mark_videos_as_watched`. */
export function markVideosAsWatched(
  item: LibraryItem,
  watched: WatchedBitField,
  videos: readonly Pick<MetaVideo, 'id' | 'released'>[],
  isWatchedNow: boolean,
): WatchedBitField {
  const next = watched.clone();
  for (const video of videos) next.setVideo(video.id, isWatchedNow);
  item.state.watched = next.toString();
  if (isWatchedNow) {
    item.state.lastWatched = lastWatchedAfterMarking(
      item.state.lastWatched,
      videos.at(-1)?.released,
    );
  }
  return next;
}

/** `ActionCtx::AddToLibrary`, after the item is built from the meta: in the library, not temporary. */
export function addToLibrary(item: LibraryItem): void {
  item.removed = false;
  item.temp = false;
}

/** `ActionCtx::RemoveFromLibrary`: removed and not temporary, so it leaves continue watching too. Progress is kept. */
export function removeFromLibrary(item: LibraryItem): void {
  item.removed = true;
  item.temp = false;
}

/** `ActionCtx::RewindLibraryItem`: nothing left to resume. */
export function rewind(item: LibraryItem): void {
  item.state.timeOffset = 0;
}

/** `LibraryItem::advance_to_video`. */
export function advanceToVideo(item: LibraryItem, videoId: string): void {
  item.state.video_id = videoId;
  item.state.overallTimeWatched += item.state.timeWatched;
  item.state.timeWatched = 0;
  item.state.flaggedWatched = 0;
  item.state.timeOffset = 1;
}

const orderKey = (value: number | undefined) => value ?? Number.MIN_SAFE_INTEGER;
const releasedKey = (released: string | undefined) => {
  const ms = released === undefined ? Number.NaN : Date.parse(released);
  return Number.isNaN(ms) ? Number.MIN_SAFE_INTEGER : ms;
};
/** `series_info` is `Some` only with both a season and an episode. */
const seriesInfo = (video: Pick<MetaVideo, 'season' | 'episode'>) =>
  video.season !== undefined && video.episode !== undefined
    ? { season: video.season, episode: video.episode }
    : undefined;

/**
 * `LibraryItemState::watched_bitfield`: the stored field aligned to the meta's
 * videos, ordered by season, episode, then release date (specials first, unlike
 * the meta's own order). A field that doesn't parse counts as empty.
 */
export function watchedBitfield(
  state: LibraryItemState,
  videos: readonly Pick<MetaVideo, 'id' | 'season' | 'episode' | 'released'>[],
): WatchedBitField {
  const videoIds = [...videos]
    .sort((a, b) => {
      const ai = seriesInfo(a);
      const bi = seriesInfo(b);
      return (
        orderKey(ai?.season) - orderKey(bi?.season) ||
        orderKey(ai?.episode) - orderKey(bi?.episode) ||
        releasedKey(a.released) - releasedKey(b.released)
      );
    })
    .map((video) => video.id);
  if (state.watched !== null) {
    try {
      return WatchedBitField.constructAndResize(state.watched, videoIds);
    } catch {
      // Falls through to an empty field, like stremio-core.
    }
  }
  return WatchedBitField.constructFromArray([], videoIds);
}

/**
 * `MetaItem::next_video`: the video after `videoId` in the meta's order, if
 * it's released and doesn't cross from a season into the specials. None for
 * live items.
 */
export function nextVideo<V extends Pick<MetaVideo, 'id' | 'season' | 'episode' | 'released'>>(
  meta: LibraryMetaPreview & { videos: readonly V[] },
  videoId: string,
  now: number,
): V | undefined {
  if (isMetaLive(meta)) return undefined;
  const position = meta.videos.findIndex((video) => video.id === videoId);
  const current = meta.videos[position];
  const next = meta.videos[position + 1];
  if (position === -1 || current === undefined || next === undefined) return undefined;
  const curSeason = seriesInfo(current)?.season ?? 0;
  const nextSeason = seriesInfo(next)?.season ?? 0;
  const released = next.released === undefined || Date.parse(next.released) <= now;
  return (nextSeason !== 0 || curSeason === nextSeason) && released ? next : undefined;
}

export interface TimeUpdate {
  /** The playing video (the stream request's id); the item id for live items. */
  videoId: string;
  time: number;
  duration: number;
}

/**
 * `ActionPlayer::TimeChanged` on the player's library item. `watched` is the
 * player's bitfield (`watched_update`), present when the meta was loaded.
 * Returns whether the video just crossed the watched threshold.
 */
export function timeChanged(
  item: LibraryItem,
  update: TimeUpdate,
  watched: WatchedBitField | undefined,
  now: number,
): boolean {
  const { time, duration } = update;
  const videoId = isLive(item) ? item._id : update.videoId;
  const { state } = item;
  state.lastWatched = iso(now);
  if (state.video_id !== videoId) {
    // A new video (like the next episode).
    state.video_id = videoId;
    state.overallTimeWatched += state.timeWatched;
    state.timeWatched = 0;
    state.flaggedWatched = 0;
  } else {
    const timeWatched = Math.max(0, time - state.timeOffset);
    state.timeWatched += timeWatched;
    state.overallTimeWatched += timeWatched;
  }
  // Only forward progress moves the offset; seeks are reported as such.
  if (time > state.timeOffset) {
    state.timeOffset = time;
    state.duration = duration;
  }
  let crossed = false;
  if (
    !isLive(item) &&
    state.flaggedWatched === 0 &&
    state.duration > 0 &&
    state.timeWatched > state.duration * WATCHED_THRESHOLD_COEF
  ) {
    state.flaggedWatched = 1;
    state.timesWatched += 1;
    if (watched !== undefined) {
      const next = watched.clone();
      next.setVideo(videoId, true);
      state.watched = next.toString();
    }
    crossed = true;
  }
  if (item.temp && state.timesWatched === 0) item.removed = true;
  if (item.removed) item.temp = true;
  return crossed;
}

/** `ActionPlayer::Seek`: moves the offset either way without counting time watched. */
export function seek(item: LibraryItem, time: number, duration: number, now: number): void {
  item.state.lastWatched = iso(now);
  item.state.timeOffset = time;
  item.state.duration = duration;
}

/**
 * `item_state_update` on unload or item change (without the player's
 * mark-as-watched flags): live items reset to the channel; past the credits
 * the offset clears and the item moves on to the next video, if any.
 */
export function itemStateUpdate(item: LibraryItem, next: { id: string } | undefined): void {
  if (isLive(item)) {
    item.state.timeOffset = 0;
    item.state.video_id = item._id;
    return;
  }
  if (item.state.timeOffset > item.state.duration * CREDITS_THRESHOLD_COEF) {
    item.state.timeOffset = 0;
    if (next !== undefined) advanceToVideo(item, next.id);
  }
}

/**
 * `library_item_state_update` on load: playing a different video than the
 * stored one resets the offset (1 when there is a next video, so it stays in
 * continue watching). Returns true when the item changed and is pushed at once.
 */
export function libraryItemStateUpdate(
  item: LibraryItem,
  next: { id: string } | undefined,
  selectedVideoId: string,
): boolean {
  if (item.state.video_id !== null && item.state.video_id !== selectedVideoId) {
    item.state.timeOffset = next !== undefined ? 1 : 0;
    return true;
  }
  return false;
}

/** `push_to_library`: whether a throttled write is due. */
export function pushToLibraryDue(lastPush: number, now: number): boolean {
  return now - lastPush >= PUSH_TO_LIBRARY_EVERY_MS;
}

/**
 * `ContinueWatchingPreview`'s list without notifications: items in continue
 * watching, not live, most recently changed first, at most
 * {@link CONTINUE_WATCHING_SIZE}.
 */
export function continueWatching(items: readonly LibraryItem[]): LibraryItem[] {
  return items
    .filter((item) => !isLive(item) && isInContinueWatching(item))
    .sort((a, b) => Date.parse(b._mtime) - Date.parse(a._mtime))
    .slice(0, CONTINUE_WATCHING_SIZE);
}

/**
 * The video to play next for an item: Multitap's composition of stremio-core's
 * rules for `GET /v1/profiles/{id}/next/…`.
 * - none for live items and metas without videos (movies)
 * - the item's video while it has an offset (resume, or the episode
 *   `itemStateUpdate` moved on to), like `LibraryItemDeepLinks`
 * - otherwise `next_video` after the item's last video (none after the last episode)
 * - with no video yet: `defaultVideoId`, else the meta's first video
 */
export function videoToPlay(
  meta: LibraryMetaPreview & {
    videos: readonly Pick<MetaVideo, 'id' | 'season' | 'episode' | 'released'>[];
  },
  item: LibraryItem | undefined,
  now: number,
): string | null {
  if (isMetaLive(meta) || meta.videos.length === 0) return null;
  const current = item?.state.video_id ?? null;
  if (item !== undefined && current !== null) {
    if (item.state.timeOffset > 0) return current;
    return nextVideo(meta, current, now)?.id ?? null;
  }
  const preferred = meta.behaviorHints.defaultVideoId;
  if (preferred !== undefined && meta.videos.some((video) => video.id === preferred)) {
    return preferred;
  }
  return meta.videos[0]?.id ?? null;
}

type MetaWithVideos = LibraryMetaPreview & {
  videos: readonly Pick<MetaVideo, 'id' | 'season' | 'episode' | 'released'>[];
};

/**
 * `LibraryItem::reconcile_series_resume_after_watched_change`: after a season
 * was marked watched, if the item's current video is in it and watched, move
 * the resume pointer along the released watched episodes to the first released
 * unwatched one; with none left, clear the offset. Otherwise nothing changes.
 */
export function reconcileSeriesResumeAfterWatchedChange(
  item: LibraryItem,
  season: number,
  watched: WatchedBitField,
  meta: MetaWithVideos,
  now: number,
): void {
  const start = item.state.video_id;
  if (start === null || !watched.getVideo(start)) return;
  let currentId: string = start;
  const inSeason = meta.videos.some(
    (video) => video.id === currentId && seriesInfo(video)?.season === season,
  );
  if (!inSeason) return;
  for (;;) {
    const next = nextVideo(meta, currentId, now);
    if (next === undefined) {
      item.state.timeOffset = 0;
      return;
    }
    if (!watched.getVideo(next.id)) {
      advanceToVideo(item, next.id);
      return;
    }
    currentId = next.id;
  }
}

/**
 * `MetaDetails::MarkVideoAsWatched`: sets the video in the watched bitfield;
 * marking the item's current video watched moves on to the next released
 * video (offset 1, so it stays in continue watching) or, with none, clears the
 * offset.
 */
export function markVideoWatched(
  item: LibraryItem,
  meta: MetaWithVideos,
  video: Pick<MetaVideo, 'id' | 'released'>,
  isWatchedNow: boolean,
  now: number,
): void {
  markVideoAsWatched(item, watchedBitfield(item.state, meta.videos), video, isWatchedNow);
  if (isWatchedNow && item.state.video_id === video.id) {
    const next = nextVideo(meta, video.id, now);
    if (next !== undefined) advanceToVideo(item, next.id);
    else item.state.timeOffset = 0;
  }
}

/**
 * `MetaDetails::MarkSeasonAsWatched`: sets every video of the season (those
 * with both season and episode numbers); marking watched then reconciles the
 * resume pointer. Returns false, changing nothing, when the season has no videos.
 */
export function markSeasonWatched(
  item: LibraryItem,
  meta: MetaWithVideos,
  season: number,
  isWatchedNow: boolean,
  now: number,
): boolean {
  const videos = meta.videos.filter((video) => seriesInfo(video)?.season === season);
  if (videos.length === 0) return false;
  const watched = markVideosAsWatched(
    item,
    watchedBitfield(item.state, meta.videos),
    videos,
    isWatchedNow,
  );
  if (isWatchedNow) reconcileSeriesResumeAfterWatchedChange(item, season, watched, meta, now);
  return true;
}
