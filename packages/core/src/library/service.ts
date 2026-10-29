/**
 * Profiles and their libraries (okf:architecture/library-and-profiles, okf:architecture/core-persistence).
 *
 * Progress reports drive a per-profile model of stremio-core's player: the
 * first report for an item loads it (`Action::Load`), later ones are
 * `TimeChanged` (or `Seek`), `pause` is `PausedChanged`, and `stop`/`ended` or a
 * report for another item or video is `Unload`. The rules are in `rules.ts`;
 * this module holds the player state and persistence: writes are throttled to
 * one per {@link PUSH_TO_LIBRARY_EVERY_MS}, and immediate on pause, stop and item
 * change, as stremio-core pushes to its library.
 *
 * Reads (library, continue watching, next) see the persisted items, as
 * stremio-core's library does.
 */
import {
  DEFAULT_PROFILE_SETTINGS,
  EMPTY_ITEM_PLAYER_STATE,
  ItemSubtitleChoiceSchema,
  MAX_CLIENT_SETTINGS_BYTES,
  ProfileSettingsSchema,
  type ItemPlayerState,
  type ItemSubtitleChoice,
  type LastSource,
  type LibraryItem,
  type LibraryItemState,
  type LibraryItemBehaviorHints,
  type MetaDetail,
  type NextVideo,
  type Profile,
  type ProfileSettings,
  type ProfileSettingsPatch,
  type ProgressReport,
  type UpdateItemPlayerState,
  type UpdateProfile,
} from '@multitap/api';
import type { AddonService } from '../addons/index.ts';
import { metaDetailView } from '../addons/meta-view.ts';
import type { Db } from '../db/index.ts';
import type {
  ItemPlayerStateRow,
  LastSourceRow,
  LibraryItemRow,
  ProfilesTable,
} from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { randomIds, type IdGenerator } from '../lib/ids.ts';
import type { Logger } from '../log.ts';
import {
  addToLibrary,
  cloneItem,
  continueWatching,
  eqNoMtime,
  isLive,
  itemStateUpdate,
  libraryItemStateUpdate,
  markAsWatched,
  markSeasonWatched,
  markVideoWatched,
  newLibraryItem,
  nextVideo,
  pushToLibraryDue,
  refreshFromMeta,
  removeFromLibrary,
  rewind,
  seek,
  timeChanged,
  videoToPlay,
  watchedBitfield,
} from './rules.ts';

/** Looks a meta item up; undefined when no addon has it. */
export type MetaSource = (type: string, id: string) => Promise<MetaDetail | undefined>;

/** The addon layer as a {@link MetaSource}: the first addon in collection order with a meta, as in Stremio. */
export function addonMetaSource(addons: AddonService): MetaSource {
  return async (type, id) => {
    const result = await addons.aggregate('meta', type, id);
    const first = result.addons.find((outcome) => outcome.status === 'ok' && outcome.items[0]);
    const meta = first?.items[0];
    return meta === undefined ? undefined : metaDetailView(meta);
  };
}

export interface LibraryServiceDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  meta: MetaSource;
  ids?: IdGenerator;
}

/** The player model for one profile: the item it has loaded. */
interface Playback {
  itemId: string;
  type: string;
  /** The video playing (the stream request's id). */
  videoId: string;
  meta: MetaDetail | undefined;
  item: LibraryItem;
  /** The persisted item, for `eq_no_mtime`. */
  stored: LibraryItem | undefined;
  /** `push_library_item_time`; 0 (the epoch) so the first update is written. */
  lastPush: number;
}

export type NextResult =
  { kind: 'no-profile' } | { kind: 'no-meta' } | ({ kind: 'ok' } & NextVideo);

/** Why a library write changed nothing. */
export type WriteFailure = 'no-item' | 'no-meta' | 'no-video';
export type WriteResult =
  { kind: 'no-profile' } | { kind: WriteFailure } | { kind: 'ok'; item: LibraryItem };

/** `GET …/library` filters (`library_with_filters`'s type filter and `NotRemovedFilter`). */
export interface LibraryFilter {
  type?: string | undefined;
  /** false = only items in the library; true = only removed ones (including temporary). */
  removed?: boolean | undefined;
}

/** `PATCH /v1/profiles/{id}`: the updated profile, or why not. */
export type UpdateProfileResult =
  | { kind: 'ok'; profile: Profile }
  | { kind: 'no-profile' }
  /** The merged `client` bag is over `MAX_CLIENT_SETTINGS_BYTES`. */
  | { kind: 'client-too-large' };

/** What selection takes from a profile (okf:concept/source-ranking, okf:decision/auto-select-and-fallback): its languages and its last source for a video. */
export interface ProfileSelection {
  /** `audioLanguage`, then `secondaryAudioLanguage`, the ones set; empty = none (the instance default applies). */
  preferredLanguages: string[];
  /** The `sourceIdentity` the profile last played for the video, if any. */
  lastSourceIdentity?: string | undefined;
  /** The profile's stored player state for the item, when asked for one and any is stored (P1). */
  playerState?: ItemPlayerState | undefined;
}

/** A source a profile played, recorded when its session became ready. */
export interface LastSourceRecord {
  itemId: string;
  videoId: string;
  sourceIdentity: string;
  addonId: string;
  addonName: string;
  name: string;
  title: string;
  bingeGroup?: string | undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();

type StoredSettings = Partial<ProfileSettings>;

const SETTING_KEYS = new Set(Object.keys(DEFAULT_PROFILE_SETTINGS));

/** The stored (sparse) settings: unknown keys and unreadable rows are dropped. */
function storedSettings(json: string | null): StoredSettings {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const known: StoredSettings = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => SETTING_KEYS.has(key)),
    );
    return known;
  } catch {
    return {};
  }
}

/** Stored settings over the defaults; a stored value that no longer validates falls back to its default. */
function effectiveSettings(stored: StoredSettings): ProfileSettings {
  const merged = { ...DEFAULT_PROFILE_SETTINGS, ...stored } as Record<string, unknown>;
  const result = ProfileSettingsSchema.safeParse(merged);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in DEFAULT_PROFILE_SETTINGS) {
      merged[key] = DEFAULT_PROFILE_SETTINGS[key as keyof ProfileSettings];
    }
  }
  return ProfileSettingsSchema.safeParse(merged).data ?? DEFAULT_PROFILE_SETTINGS;
}

/** Applies a patch to the stored settings; `client` keys merge, a null value removes one. */
function patchedSettings(stored: StoredSettings, patch: ProfileSettingsPatch): StoredSettings {
  const { client, ...typed } = patch;
  const out: StoredSettings = { ...stored };
  Object.assign(out, typed);
  if (client !== undefined) {
    const merged = { ...(stored.client ?? {}), ...client };
    out.client = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
  }
  return out;
}

function profileView(
  row: Pick<ProfilesTable, 'id' | 'name' | 'created_at' | 'settings_json'>,
): Profile {
  return {
    id: row.id,
    name: row.name,
    createdAt: iso(row.created_at),
    settings: effectiveSettings(storedSettings(row.settings_json)),
  };
}

function lastSourceView(row: LastSourceRow): LastSource {
  const view: LastSource = {
    sourceIdentity: row.source_identity,
    videoId: row.video_id,
    addonId: row.addon_id,
    addonName: row.addon_name,
    name: row.name,
    title: row.title,
    playedAt: iso(row.played_at),
  };
  if (row.binge_group !== null) view.bingeGroup = row.binge_group;
  return view;
}

/** A stored subtitle choice; one that no longer validates reads as no choice. */
function subtitleChoice(json: string | null): ItemSubtitleChoice | null {
  if (json === null) return null;
  try {
    const parsed = ItemSubtitleChoiceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function playerStateView(row: ItemPlayerStateRow): ItemPlayerState {
  return {
    audioLanguage: row.audio_language,
    subtitle: subtitleChoice(row.subtitle_json),
    subtitleOffsetMs: row.subtitle_offset_ms,
    playbackSpeed: row.playback_speed,
    updatedAt: iso(row.updated_at),
  };
}

function itemFromRow(row: LibraryItemRow): LibraryItem {
  return {
    _id: row.item_id,
    name: row.name,
    type: row.type,
    poster: row.poster,
    posterShape: row.poster_shape as LibraryItem['posterShape'],
    removed: row.removed === 1,
    temp: row.temp === 1,
    _ctime: row.ctime === null ? null : iso(row.ctime),
    _mtime: iso(row.mtime),
    state: JSON.parse(row.state_json) as LibraryItemState,
    behaviorHints: JSON.parse(row.behavior_hints_json) as LibraryItemBehaviorHints,
  };
}

export class LibraryService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #meta: MetaSource;
  readonly #ids: IdGenerator;
  readonly #playbacks = new Map<string, Playback>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(deps: LibraryServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#meta = deps.meta;
    this.#ids = deps.ids ?? randomIds;
  }

  // ---- Profiles ---------------------------------------------------------------------

  async createProfile(name: string): Promise<Profile> {
    const row = { id: this.#ids.profile(), name, created_at: this.#clock(), settings_json: null };
    await this.#db.insertInto('profiles').values(row).execute();
    return profileView(row);
  }

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.#db
      .selectFrom('profiles')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(profileView);
  }

  async getProfile(id: string): Promise<Profile | undefined> {
    const row = await this.#db
      .selectFrom('profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : profileView(row);
  }

  /**
   * `PATCH /v1/profiles/{id}`: a new name and/or settings. Typed settings
   * replace their stored value; `client` keys merge into the stored bag. Only
   * what was set is stored, so unset fields follow the defaults.
   */
  async updateProfile(id: string, update: UpdateProfile): Promise<UpdateProfileResult> {
    return this.#exclusive(id, async (): Promise<UpdateProfileResult> => {
      const row = await this.#db
        .selectFrom('profiles')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) return { kind: 'no-profile' };
      const set: { name?: string; settings_json?: string } = {};
      if (update.name !== undefined) set.name = update.name;
      if (update.settings !== undefined) {
        const next = patchedSettings(storedSettings(row.settings_json), update.settings);
        const bytes = new TextEncoder().encode(JSON.stringify(next.client ?? {})).length;
        if (bytes > MAX_CLIENT_SETTINGS_BYTES) return { kind: 'client-too-large' };
        set.settings_json = JSON.stringify(next);
      }
      if (Object.keys(set).length > 0) {
        await this.#db.updateTable('profiles').set(set).where('id', '=', id).execute();
      }
      return { kind: 'ok', profile: profileView({ ...row, ...set }) };
    });
  }

  /**
   * What selection uses from a profile for one video: its audio languages and
   * the source it last played there. Undefined for an unknown profile.
   */
  async selection(
    profileId: string,
    videoId: string,
    itemId?: string,
  ): Promise<ProfileSelection | undefined> {
    const profile = await this.getProfile(profileId);
    if (profile === undefined) return undefined;
    const { audioLanguage, secondaryAudioLanguage } = profile.settings;
    const preferredLanguages = [audioLanguage, secondaryAudioLanguage].filter(
      (lang): lang is string => lang !== null,
    );
    const last = await this.#db
      .selectFrom('last_sources')
      .select('source_identity')
      .where('profile_id', '=', profileId)
      .where('video_id', '=', videoId)
      .orderBy('played_at', 'desc')
      .executeTakeFirst();
    const selection: ProfileSelection = {
      preferredLanguages,
      lastSourceIdentity: last?.source_identity,
    };
    if (itemId !== undefined) {
      const state = await this.#readPlayerState(profileId, itemId);
      if (state !== undefined) selection.playerState = state;
    }
    return selection;
  }

  // ---- Per-item player state (P1) ----------------------------------------------------

  /**
   * The profile's player state for an item: the stored one, or the empty state
   * when nothing is stored. Undefined for an unknown profile.
   */
  async playerState(profileId: string, itemId: string): Promise<ItemPlayerState | undefined> {
    if ((await this.getProfile(profileId)) === undefined) return undefined;
    return (await this.#readPlayerState(profileId, itemId)) ?? { ...EMPTY_ITEM_PLAYER_STATE };
  }

  /**
   * Writes the fields given (null clears one), keeping the rest; returns the
   * stored state, or undefined for an unknown profile.
   */
  async setPlayerState(
    profileId: string,
    itemId: string,
    update: UpdateItemPlayerState,
  ): Promise<ItemPlayerState | undefined> {
    return this.#exclusive(profileId, async () => {
      if ((await this.getProfile(profileId)) === undefined) return undefined;
      const base = (await this.#readPlayerState(profileId, itemId)) ?? EMPTY_ITEM_PLAYER_STATE;
      const subtitle = update.subtitle === undefined ? base.subtitle : update.subtitle;
      const row = {
        audio_language:
          update.audioLanguage === undefined ? base.audioLanguage : update.audioLanguage,
        subtitle_json: subtitle === null ? null : JSON.stringify(subtitle),
        subtitle_offset_ms: update.subtitleOffsetMs ?? base.subtitleOffsetMs,
        playback_speed:
          update.playbackSpeed === undefined ? base.playbackSpeed : update.playbackSpeed,
        updated_at: this.#clock(),
      };
      await this.#db
        .insertInto('item_player_states')
        .values({ profile_id: profileId, item_id: itemId, ...row })
        .onConflict((oc) => oc.columns(['profile_id', 'item_id']).doUpdateSet(row))
        .execute();
      return playerStateView({ profile_id: profileId, item_id: itemId, ...row });
    });
  }

  async #readPlayerState(profileId: string, itemId: string): Promise<ItemPlayerState | undefined> {
    const row = await this.#db
      .selectFrom('item_player_states')
      .selectAll()
      .where('profile_id', '=', profileId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
    return row === undefined ? undefined : playerStateView(row);
  }

  /**
   * Records the source a profile played for an item: one row per item, the
   * latest replacing the earlier whatever its video. Nothing happens for a
   * profile deleted meanwhile.
   */
  async recordLastSource(profileId: string, source: LastSourceRecord): Promise<void> {
    await this.#exclusive(profileId, async () => {
      if ((await this.getProfile(profileId)) === undefined) return;
      const row = {
        video_id: source.videoId,
        source_identity: source.sourceIdentity,
        addon_id: source.addonId,
        addon_name: source.addonName,
        name: source.name,
        title: source.title,
        binge_group: source.bingeGroup ?? null,
        played_at: this.#clock(),
      };
      await this.#db
        .insertInto('last_sources')
        .values({ profile_id: profileId, item_id: source.itemId, ...row })
        .onConflict((oc) => oc.columns(['profile_id', 'item_id']).doUpdateSet(row))
        .execute();
    });
  }

  /** Deletes the profile and its library (the foreign key cascades). */
  async deleteProfile(id: string): Promise<boolean> {
    return this.#exclusive(id, async () => {
      this.#playbacks.delete(id);
      const result = await this.#db.deleteFrom('profiles').where('id', '=', id).executeTakeFirst();
      return result.numDeletedRows > 0n;
    });
  }

  // ---- Reads -------------------------------------------------------------------------

  /** Every persisted item, most recently changed first; undefined for an unknown profile. */
  async library(profileId: string, filter: LibraryFilter = {}): Promise<LibraryItem[] | undefined> {
    if ((await this.getProfile(profileId)) === undefined) return undefined;
    let query = this.#db
      .selectFrom('library_items')
      .selectAll()
      .where('profile_id', '=', profileId);
    if (filter.type !== undefined) query = query.where('type', '=', filter.type);
    if (filter.removed !== undefined) query = query.where('removed', '=', filter.removed ? 1 : 0);
    const rows = await query.orderBy('mtime', 'desc').orderBy('item_id').execute();
    const lastSources = await this.#db
      .selectFrom('last_sources')
      .selectAll()
      .where('profile_id', '=', profileId)
      .execute();
    const byItem = new Map(lastSources.map((row) => [row.item_id, lastSourceView(row)]));
    const playerStates = await this.#db
      .selectFrom('item_player_states')
      .selectAll()
      .where('profile_id', '=', profileId)
      .execute();
    const stateByItem = new Map(playerStates.map((row) => [row.item_id, playerStateView(row)]));
    return rows.map((row) => {
      const item = itemFromRow(row);
      const lastSource = byItem.get(item._id);
      if (lastSource !== undefined) item.lastSource = lastSource;
      const playerState = stateByItem.get(item._id);
      if (playerState !== undefined) item.playerState = playerState;
      return item;
    });
  }

  async continueWatching(profileId: string): Promise<LibraryItem[] | undefined> {
    const items = await this.library(profileId);
    return items === undefined ? undefined : continueWatching(items);
  }

  async next(profileId: string, type: string, id: string): Promise<NextResult> {
    if ((await this.getProfile(profileId)) === undefined) return { kind: 'no-profile' };
    const meta = await this.#lookUp(type, id);
    if (meta === undefined) return { kind: 'no-meta' };
    const libraryItem = (await this.#readItem(profileId, id)) ?? null;
    const videoId = videoToPlay(meta, libraryItem ?? undefined, this.#clock());
    const video = videoId === null ? null : (meta.videos.find((v) => v.id === videoId) ?? null);
    return { kind: 'ok', videoId, video, libraryItem };
  }

  // ---- Library writes ----------------------------------------------------------------
  //
  // Each is written at once (not throttled) through the same per-profile queue and
  // the same player model as progress: an item being played is edited in place, so
  // the next progress write doesn't undo the edit.

  /** `AddToLibrary`: the item from the addons' meta (or the stored item when none answers), in the library. */
  async addToLibrary(profileId: string, type: string, id: string): Promise<WriteResult> {
    return this.#edit(profileId, id, async (base, now) => {
      const meta = await this.#lookUp(type, id);
      let item: LibraryItem;
      if (meta !== undefined) {
        item = base !== undefined ? refreshFromMeta(meta, base) : newLibraryItem(meta, now);
      } else if (base !== undefined) {
        item = base;
      } else {
        return 'no-meta';
      }
      addToLibrary(item);
      return item;
    });
  }

  /** `RemoveFromLibrary`: removed, progress kept. */
  async removeFromLibrary(profileId: string, id: string): Promise<WriteResult> {
    return this.#edit(profileId, id, (base) => {
      if (base === undefined) return 'no-item';
      removeFromLibrary(base);
      return base;
    });
  }

  /** `RewindLibraryItem`. */
  async rewind(profileId: string, id: string): Promise<WriteResult> {
    return this.#edit(profileId, id, (base) => {
      if (base === undefined) return 'no-item';
      rewind(base);
      return base;
    });
  }

  /**
   * `LibraryItemMarkAsWatched` / `MetaItemMarkAsWatched`: marking watched an item
   * that isn't stored creates it (removed and temp, like playback does); unmarking
   * one that isn't stored is `no-item`.
   */
  async markWatched(
    profileId: string,
    type: string,
    id: string,
    watched: boolean,
  ): Promise<WriteResult> {
    return this.#edit(profileId, id, async (base, now) => {
      let item = base;
      if (item === undefined) {
        if (!watched) return 'no-item';
        const meta = await this.#lookUp(type, id);
        if (meta === undefined) return 'no-meta';
        item = newLibraryItem(meta, now);
      }
      markAsWatched(item, watched, now);
      return item;
    });
  }

  /** `MarkVideoAsWatched` (needs the meta's videos). */
  async markVideoWatched(
    profileId: string,
    type: string,
    id: string,
    videoId: string,
    watched: boolean,
  ): Promise<WriteResult> {
    return this.#edit(profileId, id, async (base, now) => {
      const meta = await this.#lookUp(type, id);
      if (meta === undefined) return 'no-meta';
      const video = meta.videos.find((v) => v.id === videoId);
      if (video === undefined) return 'no-video';
      const item = base ?? (watched ? newLibraryItem(meta, now) : undefined);
      if (item === undefined) return 'no-item';
      markVideoWatched(item, meta, video, watched, now);
      return item;
    });
  }

  /** `MarkSeasonAsWatched` (needs the meta's videos). */
  async markSeasonWatched(
    profileId: string,
    type: string,
    id: string,
    season: number,
    watched: boolean,
  ): Promise<WriteResult> {
    return this.#edit(profileId, id, async (base, now) => {
      const meta = await this.#lookUp(type, id);
      if (meta === undefined) return 'no-meta';
      const item = base ?? (watched ? newLibraryItem(meta, now) : undefined);
      if (item === undefined) return 'no-item';
      return markSeasonWatched(item, meta, season, watched, now) ? item : 'no-video';
    });
  }

  // ---- Progress ----------------------------------------------------------------------

  /**
   * Applies a progress report; returns the profile's current item (which may be
   * ahead of the persisted one by up to the throttle), or undefined for an
   * unknown profile.
   */
  async report(profileId: string, report: ProgressReport): Promise<LibraryItem | undefined> {
    return this.#exclusive(profileId, async () => {
      if ((await this.getProfile(profileId)) === undefined) {
        this.#playbacks.delete(profileId);
        return undefined;
      }
      const now = this.#clock();
      const event = report.event ?? 'progress';
      let playback = this.#playbacks.get(profileId);

      // Another item, or another video of it: unload the one playing.
      if (
        playback !== undefined &&
        (playback.itemId !== report.item.id ||
          playback.type !== report.item.type ||
          playback.videoId !== this.#videoIdFor(report, playback.item, playback.meta))
      ) {
        await this.#unload(profileId, playback, now);
        playback = undefined;
      }
      playback ??= await this.#load(profileId, report, now);

      const { item } = playback;
      if (event === 'seek') {
        seek(item, report.time, report.duration, now);
      } else {
        const watched =
          playback.meta !== undefined && playback.meta.videos.length > 0
            ? watchedBitfield(item.state, playback.meta.videos)
            : undefined;
        const crossed = timeChanged(
          item,
          { videoId: playback.videoId, time: report.time, duration: report.duration },
          watched,
          now,
        );
        if (crossed) {
          this.#logger.debug({ profileId, itemId: item._id }, 'library item watched');
        }
      }

      if (event === 'stop' || event === 'ended') {
        await this.#unload(profileId, playback, now);
        return cloneItem(playback.item);
      }
      if (pushToLibraryDue(playback.lastPush, now)) {
        playback.lastPush = now;
        await this.#write(profileId, playback, now);
      } else if (event === 'pause') {
        await this.#write(profileId, playback, now);
      }
      return cloneItem(item);
    });
  }

  /** Writes every loaded item as it stands (for shutdown); nothing is unloaded. */
  async flush(): Promise<void> {
    const now = this.#clock();
    await Promise.all(
      [...this.#playbacks.keys()].map((profileId) =>
        this.#exclusive(profileId, async () => {
          const playback = this.#playbacks.get(profileId);
          if (playback !== undefined) await this.#write(profileId, playback, now);
        }).catch((err: unknown) => {
          this.#logger.error({ err, profileId }, 'library flush failed');
        }),
      ),
    );
  }

  // ---- Internals ---------------------------------------------------------------------

  /** The stream request's video id: the channel for live items, the meta's default video or id for movies. */
  #videoIdFor(report: ProgressReport, item: LibraryItem, meta: MetaDetail | undefined): string {
    if (isLive(item)) return item._id;
    return report.videoId ?? meta?.behaviorHints.defaultVideoId ?? report.item.id;
  }

  /** `Action::Load`: `library_item_update`, then `library_item_state_update`. */
  async #load(profileId: string, report: ProgressReport, now: number): Promise<Playback> {
    const { type, id } = report.item;
    const meta = await this.#lookUp(type, id);
    const stored = await this.#readItem(profileId, id);
    let item: LibraryItem;
    if (meta !== undefined) {
      item = stored !== undefined ? refreshFromMeta(meta, stored) : newLibraryItem(meta, now);
    } else if (stored !== undefined) {
      item = cloneItem(stored);
    } else {
      // stremio-core needs the meta here; Multitap accepts the report's own name.
      item = newLibraryItem(
        {
          id,
          type,
          name: report.name ?? id,
          poster: report.poster,
          posterShape: 'poster',
          behaviorHints: { isLive: false, hasScheduledVideos: false },
        },
        now,
      );
    }
    const videoId = this.#videoIdFor(report, item, meta);
    const playback: Playback = { itemId: id, type, videoId, meta, item, stored, lastPush: 0 };
    const next = meta === undefined ? undefined : nextVideo(meta, videoId, now);
    if (libraryItemStateUpdate(item, next, videoId)) await this.#write(profileId, playback, now);
    this.#playbacks.set(profileId, playback);
    return playback;
  }

  /** `Action::Unload`: `item_state_update`, then an immediate write. */
  async #unload(profileId: string, playback: Playback, now: number): Promise<void> {
    this.#playbacks.delete(profileId);
    const next =
      playback.meta === undefined ? undefined : nextVideo(playback.meta, playback.videoId, now);
    itemStateUpdate(playback.item, next);
    await this.#write(profileId, playback, now);
  }

  /**
   * Edits one item under the profile's queue: `apply` gets a copy of the current
   * item (the loaded one while it's being played, else the stored one) and
   * returns the edited item or a failure. An edited item is written at once.
   */
  async #edit(
    profileId: string,
    itemId: string,
    apply: (
      base: LibraryItem | undefined,
      now: number,
    ) => LibraryItem | WriteFailure | Promise<LibraryItem | WriteFailure>,
  ): Promise<WriteResult> {
    return this.#exclusive(profileId, async (): Promise<WriteResult> => {
      if ((await this.getProfile(profileId)) === undefined) {
        this.#playbacks.delete(profileId);
        return { kind: 'no-profile' };
      }
      const now = this.#clock();
      const loaded = this.#playbacks.get(profileId);
      const playback = loaded?.itemId === itemId ? loaded : undefined;
      const stored = await this.#readItem(profileId, itemId);
      const current = playback?.item ?? stored;
      const result = await apply(current === undefined ? undefined : cloneItem(current), now);
      if (typeof result === 'string') return { kind: result };
      const target = playback ?? { item: result, stored };
      target.item = result;
      await this.#write(profileId, target, now);
      return { kind: 'ok', item: cloneItem(target.item) };
    });
  }

  /** `Internal::UpdateLibraryItem`: written, with a new mtime, only when it changed. */
  async #write(
    profileId: string,
    playback: { item: LibraryItem; stored: LibraryItem | undefined },
    now: number,
  ): Promise<void> {
    if (playback.stored !== undefined && eqNoMtime(playback.item, playback.stored)) return;
    playback.item._mtime = iso(now);
    const item = playback.item;
    const row = {
      type: item.type,
      name: item.name,
      poster: item.poster,
      poster_shape: item.posterShape,
      removed: item.removed ? 1 : 0,
      temp: item.temp ? 1 : 0,
      state_json: JSON.stringify(item.state),
      behavior_hints_json: JSON.stringify(item.behaviorHints),
      ctime: item._ctime === null ? null : Date.parse(item._ctime),
      mtime: now,
    };
    await this.#db
      .insertInto('library_items')
      .values({ profile_id: profileId, item_id: item._id, ...row })
      .onConflict((oc) => oc.columns(['profile_id', 'item_id']).doUpdateSet(row))
      .execute();
    playback.stored = cloneItem(item);
  }

  async #readItem(profileId: string, itemId: string): Promise<LibraryItem | undefined> {
    const row = await this.#db
      .selectFrom('library_items')
      .selectAll()
      .where('profile_id', '=', profileId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
    return row === undefined ? undefined : itemFromRow(row);
  }

  /** Best effort: an addon failure leaves the item without meta. */
  async #lookUp(type: string, id: string): Promise<MetaDetail | undefined> {
    try {
      return await this.#meta(type, id);
    } catch (err) {
      this.#logger.warn({ err, type, id }, 'meta lookup for the library failed');
      return undefined;
    }
  }

  /** Runs `fn` after every earlier call for the same profile has finished. */
  async #exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }
}
