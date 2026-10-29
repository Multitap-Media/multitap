/**
 * Profiles and their Stremio-format library (okf:architecture/library-and-profiles, okf:architecture/library-and-profiles, okf:architecture/core-v1-api).
 *
 * `LibraryItem` is stremio-core's `LibraryItem` as it serializes
 * (`ref/stremio-core/src/types/library/library_item.rs`): the same field names
 * (`_id`, `_ctime`, `_mtime`, `state.video_id`, …), so a profile can later be
 * synced to a Stremio account without converting. Times in `state` are
 * milliseconds, like stremio-core.
 */
import { z } from 'zod';
import { MetaVideoSchema, POSTER_SHAPES } from './browse.ts';
import { LanguageCodeSchema } from './selection.ts';
import { SubtitleOffsetMsSchema } from './sessions.ts';

const timestamp = z.iso.datetime().meta({ example: '2026-09-30T20:00:00.000Z' });
// Explicit bound: `int()` alone doesn't put the safe-integer limit in the document.
const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// ---- Profile settings (stremio-core's `Settings`) ---------------------------------------
//
// stremio-core keeps one `Settings` per profile (`ref/stremio-core/src/types/
// profile/settings.rs`). Multitap keeps the fields a headless client has a use for,
// in stremio-core's camelCase names and with its defaults, as a typed subset:
// the language fields Multitap acts on (ranking, `audioTrack`), `bingeWatching` for
// clients' auto-next, and the player fields any client of a profile shares.
// Fields of the official apps alone (`streamingServerUrl`, `gamepadSupport`,
// `escExitFullscreen`, `quitOnClose`, …) are not typed; a client keeps those and
// its own in the open `client` bag. Unknown keys in the typed subset are rejected.

/** Largest `client` bag, in bytes of its JSON. */
export const MAX_CLIENT_SETTINGS_BYTES = 16_384;
/** Longest timing setting (seek steps, next-video notice), milliseconds. */
const MAX_SETTING_MS = 600_000;

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const color = z.string().regex(COLOR_PATTERN).meta({
  description: '`#RRGGBB` or `#RRGGBBAA`, as stremio-core stores it.',
  example: '#FFFFFFFF',
});
const settingMs = z.number().int().min(0).max(MAX_SETTING_MS);
const percent = z.number().int().min(0).max(100);
const language = LanguageCodeSchema.nullable();

/** The typed settings, field by field: the shape of both the full document and the patch. */
const PROFILE_SETTINGS_SHAPE = {
  interfaceLanguage: LanguageCodeSchema.meta({ description: "The client's UI language." }),
  audioLanguage: language.meta({
    description:
      "Preferred audio language. Multitap uses it (with `secondaryAudioLanguage`) as the preferred languages of a source list or session that names this profile, after the request's own `preferredLanguage` and before the instance's `MULTITAP_SELECTION_PREFERRED_LANGUAGE`, and for the session's `audioTrack`. null (the default here, unlike stremio-core's `eng`) = the instance default.",
    example: 'eng',
  }),
  secondaryAudioLanguage: language.meta({ description: 'Second choice of audio language.' }),
  subtitlesLanguage: language.meta({
    description: 'Preferred subtitle language (for clients choosing a track).',
    example: 'eng',
  }),
  secondarySubtitlesLanguage: language,
  subtitlesAutoSelect: z.boolean(),
  subtitlesSize: z.number().int().min(0).max(255).meta({ description: 'Percent.' }),
  subtitlesFont: z.string().min(1).max(100),
  subtitlesBold: z.boolean(),
  subtitlesOffset: percent.meta({ description: 'Distance from the bottom, percent.' }),
  subtitlesTextColor: color,
  subtitlesBackgroundColor: color,
  subtitlesOutlineColor: color,
  subtitlesOpacity: percent,
  assSubtitlesStyling: z.boolean(),
  bingeWatching: z.boolean().meta({
    description:
      "stremio-core's auto-play of the next episode. Stored for clients: Multitap never starts the next episode itself (use `GET …/next/…` and `source.preferBingeGroup`).",
  }),
  nextVideoNotificationDuration: settingMs.meta({
    description: 'How long before the end to offer the next episode, ms.',
  }),
  seekTimeDuration: settingMs.meta({ description: 'Seek step, ms.' }),
  seekShortTimeDuration: settingMs.meta({ description: 'Fine seek step, ms.' }),
  playInBackground: z.boolean(),
  hardwareDecoding: z.boolean(),
  hideSpoilers: z.boolean(),
};

const ClientBagSchema = z
  .record(z.string(), z.unknown())
  .refine((bag) => jsonBytes(bag) <= MAX_CLIENT_SETTINGS_BYTES, {
    message: `The client settings must be at most ${String(MAX_CLIENT_SETTINGS_BYTES)} bytes of JSON.`,
  });

export const ProfileSettingsSchema = z
  .object({
    ...PROFILE_SETTINGS_SHAPE,
    client: ClientBagSchema.meta({
      description: `Opaque settings of the profile's clients (any JSON, at most ${String(MAX_CLIENT_SETTINGS_BYTES)} bytes). Multitap stores them and never reads them.`,
      example: { escExitFullscreen: true },
    }),
  })
  .strict()
  .meta({
    id: 'ProfileSettings',
    description:
      "stremio-core's per-profile `Settings`, in its field names and defaults, for the fields a headless client uses; `client` holds the rest.",
  });
export type ProfileSettings = z.infer<typeof ProfileSettingsSchema>;

/** stremio-core's `Settings::default()` for the typed fields, except `audioLanguage` (see there). */
export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  interfaceLanguage: 'eng',
  audioLanguage: null,
  secondaryAudioLanguage: null,
  subtitlesLanguage: 'eng',
  secondarySubtitlesLanguage: null,
  subtitlesAutoSelect: true,
  subtitlesSize: 100,
  subtitlesFont: 'Roboto',
  subtitlesBold: false,
  subtitlesOffset: 5,
  subtitlesTextColor: '#FFFFFFFF',
  subtitlesBackgroundColor: '#00000000',
  subtitlesOutlineColor: '#000000',
  subtitlesOpacity: 100,
  assSubtitlesStyling: false,
  bingeWatching: true,
  nextVideoNotificationDuration: 35_000,
  seekTimeDuration: 10_000,
  seekShortTimeDuration: 3_000,
  playInBackground: true,
  hardwareDecoding: true,
  hideSpoilers: false,
  client: {},
};

/** A settings patch: any typed field, and `client` keys merged into the bag (null removes one). */
export const ProfileSettingsPatchSchema = z
  .object({
    ...(Object.fromEntries(
      Object.entries(PROFILE_SETTINGS_SHAPE).map(([key, schema]) => [key, schema.optional()]),
    ) as {
      [K in keyof typeof PROFILE_SETTINGS_SHAPE]: z.ZodOptional<(typeof PROFILE_SETTINGS_SHAPE)[K]>;
    }),
    client: ClientBagSchema.optional().meta({
      description:
        'Merged key by key into the stored bag; a key set to null is removed. The merged bag must stay within the size limit.',
    }),
  })
  .strict()
  .meta({
    id: 'ProfileSettingsPatch',
    description: 'Any subset of `ProfileSettings`; unknown fields are rejected.',
  });
export type ProfileSettingsPatch = z.infer<typeof ProfileSettingsPatchSchema>;

// ---- Profiles ------------------------------------------------------------------------

export const ProfileSchema = z
  .object({
    id: z.string().meta({ example: 'pr_3q2x7wAbCdEfGhIjKlMnOp' }),
    name: z.string().meta({ example: 'Living room' }),
    createdAt: timestamp,
    settings: ProfileSettingsSchema.meta({
      description: 'Every setting: the stored ones over the defaults.',
    }),
  })
  .meta({ id: 'Profile' });
export type Profile = z.infer<typeof ProfileSchema>;

const profileName = z
  .string()
  .min(1)
  .max(100)
  // ECMAScript's `\s` spelled out: `\S` alone reads differently in other regex
  // engines (the contract run's generator took U+00A0 for non-whitespace).
  .regex(
    /[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/,
    'Must contain a non-whitespace character',
  )
  .meta({ example: 'Living room', description: 'Stored as given (not trimmed).' });

/** Body of `POST /v1/profiles`. */
export const CreateProfileSchema = z.object({ name: profileName }).meta({ id: 'CreateProfile' });
export type CreateProfile = z.infer<typeof CreateProfileSchema>;

/** Body of `PATCH /v1/profiles/{id}`. */
export const UpdateProfileSchema = z
  .object({
    name: profileName.optional(),
    settings: ProfileSettingsPatchSchema.optional(),
  })
  .strict()
  .meta({
    id: 'UpdateProfile',
    example: { name: 'Living room', settings: { audioLanguage: 'ita', bingeWatching: false } },
  });
export type UpdateProfile = z.infer<typeof UpdateProfileSchema>;

export const ProfileListSchema = z
  .object({ profiles: z.array(ProfileSchema).meta({ description: 'Oldest first.' }) })
  .meta({ id: 'ProfileList' });
export type ProfileList = z.infer<typeof ProfileListSchema>;

// ---- Library items (stremio-core's shape) ---------------------------------------------

export const LibraryItemStateSchema = z
  .object({
    lastWatched: timestamp.nullable(),
    timeWatched: ms.meta({ description: 'Milliseconds watched of the current video.' }),
    timeOffset: ms.meta({ description: 'Resume position in milliseconds; 0 = nothing to resume.' }),
    overallTimeWatched: ms,
    timesWatched: z.number().int().nonnegative(),
    flaggedWatched: z.number().int().min(0).max(1).meta({ description: '1 = marked watched.' }),
    duration: ms.meta({ description: 'Duration of the current video in milliseconds.' }),
    video_id: z.string().nullable().meta({
      description: 'The last video watched (stremio-core keeps this snake_case name).',
    }),
    watched: z.string().nullable().meta({
      description:
        "stremio-core's serialized watched-episodes bitfield; null for items without videos.",
    }),
    noNotif: z.boolean(),
  })
  .meta({ id: 'LibraryItemState' });
export type LibraryItemState = z.infer<typeof LibraryItemStateSchema>;

export const LibraryItemBehaviorHintsSchema = z
  .object({
    isLive: z.boolean().optional(),
    defaultVideoId: z.string().nullable(),
    featuredVideoId: z.string().nullable(),
    hasScheduledVideos: z.boolean(),
  })
  .meta({ id: 'LibraryItemBehaviorHints' });
export type LibraryItemBehaviorHints = z.infer<typeof LibraryItemBehaviorHintsSchema>;

/**
 * The source a profile last played for an item (gap analysis §2.3,
 * stremio-core's `StreamsBucket`): recorded when a playback session created
 * with the profile's `profileId` becomes ready. Only non-secret parts: the raw
 * stream stays in Multitap.
 */
export const LastSourceSchema = z
  .object({
    sourceIdentity: z.string().meta({
      description:
        "A stable hash of the stream's identity (addon, source fields, `proxyHeaders`): the candidate `key` the same stream gets in any later source list. It doesn't expire, but a key from it only plays while a list has offered it again.",
    }),
    videoId: z.string().meta({ description: 'The video it played.', example: 'tt0903747:1:1' }),
    addonId: z.string(),
    addonName: z.string(),
    name: z.string().meta({ description: "The stream's short label, as the addon gave it." }),
    title: z.string().meta({ description: "The stream's description, as the addon gave it." }),
    bingeGroup: z.string().optional().meta({
      description:
        "The source's `bingeGroup`: pass it as `source.preferBingeGroup` for the next episode.",
      example: 'torrentio|1080p|WEB-DL',
    }),
    playedAt: timestamp.meta({ description: 'When its session became ready.' }),
  })
  .meta({ id: 'LastSource' });
export type LastSource = z.infer<typeof LastSourceSchema>;

// ---- Per-item player state (stremio-core's `StreamItemState`) ------------------------

/** Slowest and fastest stored playback speed (the range browsers' media elements play). */
export const MIN_PLAYBACK_SPEED = 0.0625;
export const MAX_PLAYBACK_SPEED = 16;

const trackLanguage = z.string().min(1).max(100).meta({
  description:
    "The track's language as the file or the addon tags it (usually ISO 639-2): a new session matches the stored choice by it, since track indexes change with the source.",
  example: 'eng',
});

/**
 * The subtitle a profile chose for an item: an embedded track, an addon
 * subtitle, or subtitles off. Languages are the durable part; `index` and
 * `fileId` only hold while the same source or addon file is offered.
 */
export const ItemSubtitleChoiceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('embedded'),
        lang: trackLanguage.nullable().meta({ description: 'null: the track is untagged.' }),
        index: z.number().int().nonnegative().max(1000).meta({
          description:
            "Index into the session's `tracks.subtitles` when it was chosen; only a hint for the same source.",
        }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('addon'),
        lang: trackLanguage,
        addonId: z.string().min(1).max(500).meta({ example: 'org.stremio.opensubtitlesv3' }),
        fileId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{32}$/)
          .optional()
          .meta({
            description:
              "Multitap's subtitle file id, while that addon still offers the file (a session's `subtitles[].id`).",
            example: '3q2-7wAbCdEfGhIjKlMnOpQrStUvWxYz',
          }),
      })
      .strict(),
    z.object({ kind: z.literal('off') }).strict(),
  ])
  .meta({
    id: 'ItemSubtitleChoice',
    description:
      '`embedded` (a track of the file), `addon` (an addon subtitle) or `off` (subtitles turned off).',
  });
export type ItemSubtitleChoice = z.infer<typeof ItemSubtitleChoiceSchema>;

const playbackSpeed = z.number().min(MIN_PLAYBACK_SPEED).max(MAX_PLAYBACK_SPEED).meta({
  description: 'Playback rate (1 = normal).',
  example: 1.25,
});
const subtitleOffsetMs = SubtitleOffsetMsSchema.meta({
  description:
    'Subtitle timing offset in milliseconds, at most 600000 either way (positive shows cues later). A session created for the profile starts with it on the chosen addon subtitle file (`session_subtitle_offsets`).',
  example: -1500,
});

/**
 * A profile's player choices for an item (phase 3 P1, stremio-core's
 * `StreamItemState`): kept per profile and item, next to its last source.
 */
export const ItemPlayerStateSchema = z
  .object({
    audioLanguage: LanguageCodeSchema.nullable().meta({
      description:
        "The audio language chosen. A session created with the profile's `profileId` and no `audioLanguage` starts with it (`audioTrack`). null = no choice.",
      example: 'ita',
    }),
    subtitle: ItemSubtitleChoiceSchema.nullable().meta({
      description: 'The subtitle chosen; null = no choice (the client decides).',
    }),
    subtitleOffsetMs,
    playbackSpeed: playbackSpeed.nullable().meta({ description: 'null = no choice (normal).' }),
    updatedAt: timestamp.nullable().meta({ description: 'Last written; null = nothing stored.' }),
  })
  .meta({ id: 'ItemPlayerState' });
export type ItemPlayerState = z.infer<typeof ItemPlayerStateSchema>;

/** The state of an item nothing was stored for. */
export const EMPTY_ITEM_PLAYER_STATE: ItemPlayerState = {
  audioLanguage: null,
  subtitle: null,
  subtitleOffsetMs: 0,
  playbackSpeed: null,
  updatedAt: null,
};

/** Body of `PUT /v1/profiles/{id}/items/{type}/{itemId}/state`. */
export const UpdateItemPlayerStateSchema = z
  .object({
    audioLanguage: LanguageCodeSchema.nullable().optional(),
    subtitle: ItemSubtitleChoiceSchema.nullable().optional(),
    subtitleOffsetMs: subtitleOffsetMs.optional(),
    playbackSpeed: playbackSpeed.nullable().optional(),
  })
  .strict()
  .meta({
    id: 'UpdateItemPlayerState',
    description:
      'Each field given replaces the stored value (null clears it); fields left out are kept. Unknown fields are rejected.',
    example: {
      audioLanguage: 'ita',
      subtitle: { kind: 'addon', lang: 'eng', addonId: 'org.stremio.opensubtitlesv3' },
      subtitleOffsetMs: -1500,
    },
  });
export type UpdateItemPlayerState = z.infer<typeof UpdateItemPlayerStateSchema>;

export const LibraryItemSchema = z
  .object({
    _id: z.string().meta({ description: 'The meta id.', example: 'tt0903747' }),
    name: z.string(),
    type: z.string().meta({ example: 'series' }),
    poster: z.string().nullable(),
    posterShape: z.enum(POSTER_SHAPES),
    removed: z.boolean().meta({
      description: 'Not in the library (it may still be in continue watching while `temp`).',
    }),
    temp: z.boolean().meta({ description: 'Added by playback rather than by the user.' }),
    _ctime: timestamp.nullable(),
    _mtime: timestamp,
    state: LibraryItemStateSchema,
    behaviorHints: LibraryItemBehaviorHintsSchema,
    lastSource: LastSourceSchema.optional().meta({
      description:
        "Multitap's addition (not a stremio-core field): the source this profile last played for the item, on the library and continue-watching lists. Its `videoId` may be an earlier episode than `state.video_id`.",
    }),
    playerState: ItemPlayerStateSchema.optional().meta({
      description:
        "Multitap's addition (not a stremio-core field): the profile's player choices for the item (`GET …/items/{type}/{itemId}/state`), on the library and continue-watching lists when any are stored.",
    }),
  })
  .meta({ id: 'LibraryItem' });
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export const LibraryItemListSchema = z
  .object({
    items: z.array(LibraryItemSchema).meta({ description: 'Most recently changed first.' }),
  })
  .meta({ id: 'LibraryItemList' });
export type LibraryItemList = z.infer<typeof LibraryItemListSchema>;

// ---- Progress ---------------------------------------------------------------------------

/**
 * What happened in the player, as stremio-core's player actions (okf:architecture/library-and-profiles):
 * `progress` is `TimeChanged` (time watched counts only forward from the last
 * position), `seek` moves the position either way without counting time,
 * `pause` is written at once, and `stop`/`ended` unload the item (moving on to
 * the next episode past the credits) and are written at once.
 */
export const PROGRESS_EVENTS = ['progress', 'seek', 'pause', 'stop', 'ended'] as const;
export type ProgressEvent = (typeof PROGRESS_EVENTS)[number];

/** Body of `POST /v1/profiles/{id}/progress`. */
export const ProgressReportSchema = z
  .object({
    item: z
      .object({
        type: z.string().min(1).max(100).meta({ example: 'series' }),
        id: z.string().min(1).max(500).meta({ example: 'tt0903747' }),
      })
      .meta({ description: 'The meta item.' }),
    videoId: z.string().min(1).max(500).optional().meta({
      description: 'The video playing; absent for a movie (the meta id is used).',
      example: 'tt0903747:1:1',
    }),
    time: ms.meta({ description: 'Position in milliseconds.', example: 1_234_000 }),
    duration: ms.meta({ description: 'Duration in milliseconds.', example: 2_820_000 }),
    event: z.enum(PROGRESS_EVENTS).optional().meta({
      description:
        'Default `progress`. Report a seek as `seek`, or the jump counts as time watched.',
    }),
    name: z.string().max(500).optional().meta({
      description: "The item's name, when the client has it; otherwise Multitap looks the meta up.",
    }),
    poster: z.string().max(4096).optional(),
  })
  .meta({
    id: 'ProgressReport',
    example: {
      item: { type: 'series', id: 'tt0903747' },
      videoId: 'tt0903747:1:1',
      time: 1_234_000,
      duration: 2_820_000,
      event: 'pause',
    },
  });
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

// ---- Next episode ------------------------------------------------------------------------

export const NextVideoSchema = z
  .object({
    videoId: z.string().nullable().meta({
      description:
        'The video to play next, or null when there is none (a movie, or the last episode).',
      example: 'tt0903747:1:2',
    }),
    video: z.union([MetaVideoSchema, z.null()]),
    libraryItem: LibraryItemSchema.nullable().meta({
      description: "The profile's library item for the meta, if any.",
    }),
  })
  .meta({ id: 'NextVideo' });
export type NextVideo = z.infer<typeof NextVideoSchema>;

// ---- Library writes ----------------------------------------------------------------------

/** Body of the `…/watched` routes. */
export const MarkWatchedSchema = z
  .object({
    watched: z.boolean().meta({
      description:
        'true marks watched (one more time watched, no position to resume); false resets the watched state.',
    }),
  })
  .meta({ id: 'MarkWatched', example: { watched: true } });
export type MarkWatched = z.infer<typeof MarkWatchedSchema>;
