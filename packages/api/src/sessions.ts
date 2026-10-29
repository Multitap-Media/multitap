/**
 * Playback sessions, media tokens and per-session views (okf:architecture/playback-session,
 * okf:architecture/rendition-and-bandwidth, okf:concept/media-tokens, okf:concept/delivery-modes, okf:architecture/core-v1-api, okf:architecture/media-gateway).
 *
 * Response enums are declared in full even where phase 2 doesn't produce a
 * value yet (`status: 'preparing'`, `mode: 'full'`, `delivery: 'direct' |
 * 'remux'`), because adding a value to a response enum later breaks `/v1`
 * clients. Request enums may grow. Raw `Stream`s and engine `mediaURL`s never
 * appear here (okf:architecture/secrets-policy). Plain zod without transforms, so every schema maps
 * one-to-one onto JSON Schema.
 */
import { z } from 'zod';
import { AddonStatusSchema } from './browse.ts';
import { ENGINE_ID_PATTERN } from './engines.ts';
import {
  HDR_FORMATS,
  HIGH_RES_POLICIES,
  LanguageCodeSchema,
  MAX_BINGE_GROUP_LENGTH,
  PreferredLanguagesSchema,
  SourceCandidateSchema,
} from './selection.ts';

const timestamp = z.iso.datetime().meta({ example: '2026-09-30T20:00:00.000Z' });

// ---- Enums -----------------------------------------------------------------------

export const PLAYBACK_SESSION_STATUSES = [
  'resolving',
  'preparing',
  'ready',
  'failed',
  'released',
] as const;
export type PlaybackSessionStatus = (typeof PLAYBACK_SESSION_STATUSES)[number];

/** How a session's media reaches players (okf:concept/delivery-modes). Phase 2 builds only `transcode`. */
export const DELIVERIES = ['direct', 'remux', 'transcode'] as const;
export type Delivery = (typeof DELIVERIES)[number];

/** Requested delivery: `auto` lets Multitap choose (always `transcode` in phase 2). */
export const DELIVERY_REQUESTS = ['auto', ...DELIVERIES] as const;
export type DeliveryRequest = (typeof DELIVERY_REQUESTS)[number];

/** `full` transcodes every segment ahead of time (okf:architecture/engine-prepare-ahead, phase 4). */
export const SESSION_MODES = ['play', 'full'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** The engine module's phases (okf:architecture/engine-module). */
export const ENGINE_PHASES = [
  'metadata',
  'probing',
  'ready',
  'preparing',
  'prepared',
  'failed',
] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

/** The file a session's media starts from, under `/media/{token}/` (okf:architecture/media-gateway). */
export const MEDIA_ENTRIES = ['master.m3u8', 'stream'] as const;
export type MediaEntry = (typeof MEDIA_ENTRIES)[number];

/** Why a session was released. */
export const RELEASE_REASONS = ['request', 'retention', 'admin'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

// ---- Shared parts ----------------------------------------------------------------

/** Lowest and highest `quality.maxHeight` a request may ask for (okf:architecture/rendition-and-bandwidth). */
export const QUALITY_MIN_HEIGHT = 144;
export const QUALITY_MAX_HEIGHT = 2160;
/** Lowest and highest `quality.bitrate`, bits per second, as upstream #25 accepts. */
export const QUALITY_MIN_BITRATE = 100_000;
export const QUALITY_MAX_BITRATE = 200_000_000;

export const SessionItemSchema = z
  .object({
    type: z.string().min(1).max(100).meta({ example: 'series' }),
    id: z.string().min(1).max(500).meta({ description: 'The meta id.', example: 'tt0903747' }),
    videoId: z.string().min(1).max(500).optional().meta({
      description: 'The video id, for an episode.',
      example: 'tt0903747:1:1',
    }),
  })
  .meta({ id: 'SessionItem' });
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const PickedSourceSchema = z
  .object({
    key: z.string().min(1).max(200).meta({
      description:
        'A candidate key from a source list (`SourceCandidate.key`). Keys expire with the list (`MULTITAP_STREAM_STORE_TTL_MS`); an expired one gets `409`.',
    }),
  })
  .meta({ id: 'PickedSource' });

export const AutoSourceSchema = z
  .object({
    auto: z.literal(true).meta({
      description: 'Let Multitap rank the sources and pick.',
    }),
    preferBingeGroup: z.string().min(1).max(MAX_BINGE_GROUP_LENGTH).optional().meta({
      description:
        "Prefer candidates with this `bingeGroup`: pass the previous episode's session `bingeGroup` to keep its release (auto-next). A strong rank bonus (`binge.matchBonus`); unplayable candidates stay unplayable, and the normal ranking is the fallback. Part of the session's identity.",
      example: 'torrentio|1080p|WEB-DL',
    }),
  })
  .meta({ id: 'AutoSource' });

export const SessionSourceSchema = z
  .union([PickedSourceSchema, AutoSourceSchema])
  .meta({ id: 'SessionSource' });
export type SessionSource = z.infer<typeof SessionSourceSchema>;

export const SessionQualitySchema = z
  .object({
    maxHeight: z.number().int().min(QUALITY_MIN_HEIGHT).max(QUALITY_MAX_HEIGHT).optional().meta({
      description: "Tallest output, in pixels. Capped at the engine's `liveMaxHeight`.",
      example: 720,
    }),
    bitrate: z.number().int().min(QUALITY_MIN_BITRATE).max(QUALITY_MAX_BITRATE).optional().meta({
      description:
        "Video bitrate in bits per second. Capped at `MULTITAP_SESSION_MAX_BITRATE`. A request with `maxHeight` and no `bitrate` gets one derived from the height (`MULTITAP_SESSION_BITRATE_BY_HEIGHT`, at most the engine's `defaultBitrate`), and a session's `quality` shows it.",
      example: 6_000_000,
    }),
  })
  .meta({ id: 'SessionQuality' });
export type SessionQuality = z.infer<typeof SessionQualitySchema>;

export const EngineMediaInfoSchema = z
  .object({
    height: z.number().int().nonnegative().optional(),
    width: z.number().int().nonnegative().optional(),
    hdr: z.enum(HDR_FORMATS).optional(),
    codec: z.string().optional().meta({ example: 'hevc' }),
    durationSec: z.number().nonnegative().optional(),
  })
  .meta({ id: 'EngineMediaInfo' });
export type EngineMediaInfo = z.infer<typeof EngineMediaInfoSchema>;

/** The engine module's `status(handle)` (okf:architecture/engine-module), as a session's `progress`. */
export const EngineStatusSchema = z
  .object({
    phase: z.enum(ENGINE_PHASES),
    peers: z.number().int().nonnegative().optional().meta({ description: 'Torrents only.' }),
    downloadSpeed: z
      .number()
      .nonnegative()
      .optional()
      .meta({ description: 'Bytes per second; torrents only.' }),
    preparedPct: z.number().min(0).max(100).optional().meta({ description: 'Mode `full` only.' }),
    info: EngineMediaInfoSchema.optional().meta({
      description: "The engine's probe of the source.",
    }),
  })
  .meta({ id: 'EngineStatus' });
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const MediaTrackSchema = z
  .object({
    index: z.number().int().nonnegative().meta({
      description:
        "Position among the session's tracks of this kind, which is the master playlist's rendition order: the hls.js `audioTracks` / `subtitleTracks` index.",
    }),
    lang: z.string().optional().meta({
      description: 'As the file tags it (usually ISO 639-2); absent when untagged.',
      example: 'eng',
    }),
    codec: z.string().optional().meta({ description: 'Source codec.', example: 'eac3' }),
    channels: z.number().int().positive().optional().meta({ description: 'Audio only.' }),
    default: z.boolean().meta({ description: 'The file marks this track as default.' }),
  })
  .meta({ id: 'MediaTrack' });
export type MediaTrack = z.infer<typeof MediaTrackSchema>;

/** The tracks a session's master playlist offers, from the engine's probe of the source. */
export const SessionTracksSchema = z
  .object({
    audio: z.array(MediaTrackSchema).meta({
      description:
        'Every audio track. With two or more the master has an audio rendition group (one per track, in this order) and the engine starts on the first default-marked one, else the first; with one, the audio is muxed into the video and there is nothing to select.',
    }),
    subtitles: z.array(MediaTrackSchema).meta({
      description:
        'Embedded text subtitles, one WebVTT rendition each, in this order. Image subtitles (PGS, VobSub) are not offered and not listed.',
    }),
  })
  .meta({ id: 'SessionTracks' });
export type SessionTracks = z.infer<typeof SessionTracksSchema>;

// ---- PlaybackSession -------------------------------------------------------------

export const PlaybackSessionSchema = z
  .object({
    id: z.string().meta({ description: '`ps_` + random.', example: 'ps_3q2x7wAbCdEfGhIjKlMnOp' }),
    key: z.string().optional().meta({
      description: "The client's grouping key; creation is idempotent per key.",
      example: 'living-room',
    }),
    item: SessionItemSchema,
    profileId: z.string().optional().meta({
      description: "The create request's `profileId`, when it had one.",
      example: 'pr_3q2x7wAbCdEfGhIjKlMnOp',
    }),
    engineId: z.string().optional().meta({ example: 'home' }),
    source: SessionSourceSchema,
    candidates: z.array(SourceCandidateSchema).optional().meta({
      description: 'Auto-select only: the fallback order.',
    }),
    chosen: z.string().optional().meta({ description: 'The candidate key actually playing.' }),
    bingeGroup: z.string().optional().meta({
      description:
        "The playing source's `bingeGroup`, once `ready`. Pass it as `source.preferBingeGroup` when creating the next episode's session to keep the release.",
      example: 'torrentio|1080p|WEB-DL',
    }),
    tracks: SessionTracksSchema.optional().meta({
      description: 'The audio and subtitle tracks of the playing source, once `ready`.',
    }),
    audioTrack: z.number().int().nonnegative().optional().meta({
      description:
        "Index into `tracks.audio` of the track to start with: the first track in the create request's `audioLanguage`, else in its preferred languages (request, else the profile's, else the instance default), default-marked tracks first. Absent with fewer than two audio tracks or no match. The engine can't choose the default audio track, so clients select it (hls.js `audioTrack = audioTrack`).",
    }),
    delivery: z.enum(DELIVERIES).meta({
      description: 'How media reaches players. Fixed once `ready`.',
    }),
    mediaEntry: z.enum(MEDIA_ENTRIES).meta({
      description:
        'The file a player opens under `/media/{token}/`: `master.m3u8` for `transcode`, `stream` for `direct` and `remux`. A token response gives the full `mediaPath`.',
    }),
    mode: z.enum(SESSION_MODES),
    highRes: z.enum(HIGH_RES_POLICIES),
    quality: SessionQualitySchema.optional().meta({
      description:
        'What the engine applied. Absent when nothing was requested or the engine has no `sessionOverrides`.',
    }),
    readyBy: timestamp.optional().meta({ description: 'Preparation deadline.' }),
    retainUntil: timestamp.optional().meta({ description: 'Client-set retention floor.' }),
    status: z.enum(PLAYBACK_SESSION_STATUSES),
    failureReason: z.string().optional().meta({
      description:
        'Coarse reason for `failed`: an engine reason (`unsupported`, `external`, `live`, `needs-prepare`, `probe-failed`, `torrent-failed`, `engine-offline`, `engine-error`, `engine-busy`: the engine is at its torrent cap; try again shortly) or a session one (`no-candidates`, `only-flagged`: every playable source is flagged `destructive` and auto-select skips those, `candidates-exhausted`, `attempts-exhausted`, `interrupted`, `internal-error`).',
      example: 'needs-prepare',
    }),
    progress: EngineStatusSchema.optional(),
    tokenEpoch: z.number().int().nonnegative().meta({
      description: 'Bumped by revoke-all; tokens minted under an older epoch stop working.',
    }),
    createdAt: timestamp,
    lastAccess: timestamp.meta({ description: 'Last media request or session read.' }),
    releasedAt: timestamp.optional(),
  })
  .meta({ id: 'PlaybackSession' });
export type PlaybackSession = z.infer<typeof PlaybackSessionSchema>;

/** Body of `POST /v1/sessions`. */
export const CreateSessionSchema = z
  .object({
    key: z.string().min(1).max(200).optional().meta({
      description:
        'Grouping key. A create with the key, item, source, delivery and quality of an open session returns that session (for auto-select, `preferredLanguage` counts too).',
      example: 'living-room',
    }),
    item: SessionItemSchema,
    source: SessionSourceSchema,
    engine: z.string().regex(new RegExp(ENGINE_ID_PATTERN)).optional().meta({
      description:
        "Engine to play on. A candidate's engine affinity wins; default `MULTITAP_SELECTION_DEFAULT_ENGINE`, else the only engine there is.",
    }),
    delivery: z.enum(DELIVERY_REQUESTS).optional().meta({
      description: 'Default `auto` (always `transcode` for now). `direct` and `remux` get `501`.',
    }),
    mode: z.enum(SESSION_MODES).optional().meta({
      description: 'Default `play`. `full` gets `501` until preparation is built.',
    }),
    highRes: z.enum(HIGH_RES_POLICIES).optional().meta({
      description: 'Default `MULTITAP_SELECTION_DEFAULT_HIGH_RES`.',
    }),
    quality: SessionQualitySchema.optional(),
    readyBy: timestamp.optional().meta({
      description: 'Preparation deadline. Gets `501` until preparation is built.',
    }),
    retainUntil: timestamp.optional(),
    preferredLanguage: PreferredLanguagesSchema.optional().meta({
      description:
        "Preferred audio languages for this session, most preferred first: auto-select's ranking and the fallback for `audioTrack`. Default: the profile's audio languages (with `profileId`), else the instance's `MULTITAP_SELECTION_PREFERRED_LANGUAGE`. Part of an auto-select session's identity.",
    }),
    audioLanguage: LanguageCodeSchema.optional().meta({
      description:
        "The audio language the client wants to start with. Resolved to the session's `audioTrack` once the source is probed; not part of the identity (the media is the same).",
      example: 'ita',
    }),
    profileId: z.string().min(1).max(100).optional().meta({
      description:
        "The profile this playback is for. Its audio languages are the preferred languages when the request has no `preferredLanguage` (request > profile > instance default); auto-select ranks the source the profile last played for this video up (`lastSource.matchBonus`); and when the session becomes ready its source is recorded as the profile's `lastSource` for the item. An unknown profile gets `400`. Part of an auto-select session's identity. Progress is still reported separately (`POST /v1/profiles/{id}/progress`).",
      example: 'pr_3q2x7wAbCdEfGhIjKlMnOp',
    }),
  })
  .meta({
    id: 'CreateSession',
    example: {
      key: 'living-room',
      item: { type: 'movie', id: 'tt1375666' },
      source: { auto: true },
      quality: { maxHeight: 720 },
    },
  });
export type CreateSession = z.infer<typeof CreateSessionSchema>;

/** Body of `PATCH /v1/sessions/{id}`. `null` clears a value. Quality can't be patched (okf:architecture/rendition-and-bandwidth). */
export const UpdateSessionSchema = z
  .object({
    retainUntil: timestamp.nullable().optional(),
    readyBy: timestamp.nullable().optional().meta({
      description: 'Gets `501` until preparation is built.',
    }),
  })
  .meta({ id: 'UpdateSession' });
export type UpdateSession = z.infer<typeof UpdateSessionSchema>;

// ---- Media tokens (okf:concept/media-tokens) -----------------------------------------------------------

/** Longest `ttl` a mint request can state, in seconds; `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS` may lower it. */
export const TOKEN_MAX_TTL_SEC = 30 * 86_400;
export const TOKEN_MIN_TTL_SEC = 60;

const subject = z.string().min(1).max(200).meta({
  description: 'Opaque viewer id chosen by the client; used for revocation and telemetry.',
  example: 'living-room',
});

/** Body of `POST /v1/sessions/{id}/tokens`. */
export const MintTokenSchema = z
  .object({
    subject: subject.refine((s) => s !== 'revoke-all', {
      message: 'The subject value "revoke-all" is reserved and cannot be used.',
    }),
    ttl: z.number().int().min(TOKEN_MIN_TTL_SEC).max(TOKEN_MAX_TTL_SEC).optional().meta({
      description: 'Lifetime in seconds; default `MULTITAP_MEDIA_TOKEN_TTL_MS` (8 h).',
      example: 28_800,
    }),
  })
  .meta({ id: 'MintToken' });
export type MintToken = z.infer<typeof MintTokenSchema>;

export const MediaTokenSchema = z
  .object({
    token: z
      .string()
      .meta({ description: 'Bearer credential; it is a path segment of `mediaPath`.' }),
    subject,
    sessionId: z.string(),
    mediaPath: z.string().meta({
      description:
        'Path on the media listener, depending on `delivery`: `/media/{token}/master.m3u8` for transcode, `/media/{token}/stream` for direct and remux.',
      example: '/media/eyJhbGciOiJIUzI1NiJ9.e30.sig/master.m3u8',
    }),
    mediaUrl: z.string().optional().meta({
      description:
        'Absolute URL (`MULTITAP_MEDIA_PUBLIC_BASE` + `mediaPath`); present when Multitap is configured with a public media base.',
    }),
    exp: timestamp.meta({ description: 'When the token expires.' }),
  })
  .meta({ id: 'MediaToken' });
export type MediaToken = z.infer<typeof MediaTokenSchema>;

/** Response of `POST /v1/sessions/{id}/tokens/revoke-all`. */
export const RevokeAllTokensSchema = z
  .object({ tokenEpoch: z.number().int().nonnegative() })
  .meta({ id: 'RevokeAllTokens' });
export type RevokeAllTokens = z.infer<typeof RevokeAllTokensSchema>;

// ---- Viewers (okf:architecture/media-gateway-proxy telemetry) ------------------------------------------------------

export const ViewerSchema = z
  .object({
    subject,
    lastFile: z.string().optional().meta({
      description: 'The last media file requested (`seg12.ts`, `playlist.m3u8`, …).',
      example: 'seg12.ts',
    }),
    lastSegment: z.number().int().nonnegative().optional().meta({
      description: 'Index of the last video segment requested.',
    }),
    lastRequestAt: timestamp.optional(),
    bytes: z.number().int().nonnegative().meta({ description: 'Bytes sent to this subject.' }),
    requests: z.number().int().nonnegative(),
  })
  .meta({ id: 'Viewer' });
export type Viewer = z.infer<typeof ViewerSchema>;

export const ViewerListSchema = z
  .object({ viewers: z.array(ViewerSchema) })
  .meta({ id: 'ViewerList' });
export type ViewerList = z.infer<typeof ViewerListSchema>;

// ---- Session subtitles (okf:architecture/core-v1-api) ------------------------------------------------------

/** The largest subtitle timing offset, either way. */
export const SUBTITLE_OFFSET_MAX_MS = 600_000;

/** Signed milliseconds: positive shows cues later, negative earlier. */
export const SubtitleOffsetMsSchema = z
  .number()
  .int()
  .min(-SUBTITLE_OFFSET_MAX_MS)
  .max(SUBTITLE_OFFSET_MAX_MS)
  .meta({
    description:
      'Subtitle timing offset in milliseconds, at most 600000 either way: positive shows cues later, negative earlier. ' +
      'A cue that ends at or before 0 afterwards is dropped; a start before 0 becomes 0.',
    example: -1500,
  });

export const SubtitleOffsetSchema = z
  .object({ offsetMs: SubtitleOffsetMsSchema })
  .meta({ id: 'SubtitleOffset' });
export type SubtitleOffset = z.infer<typeof SubtitleOffsetSchema>;

export const SessionSubtitleTrackSchema = z
  .object({
    id: z.string().meta({ description: "Multitap's id for the file; stable while it's cached." }),
    lang: z
      .string()
      .meta({ description: 'As the addon gave it, usually ISO 639-2.', example: 'eng' }),
    label: z.string().optional(),
    addonId: z.string(),
    path: z.string().meta({
      description:
        'Relative to the media base: load it as `/media/{token}/{path}` with the same token, e.g. from a `<track crossorigin>`.',
      example: 'ext/sub/3q2-7wAbCdEfGhIjKlMnOpQrStUvWxYz.vtt',
    }),
    offsetMs: SubtitleOffsetMsSchema.meta({
      description:
        "The session's timing offset for this track, applied by the media listener to every viewer (`PUT /v1/sessions/{id}/subtitles/{fileId}/offset`); 0 when none is set. A request's own `?offsetMs=` is added on top.",
    }),
  })
  .meta({ id: 'SessionSubtitleTrack' });
export type SessionSubtitleTrack = z.infer<typeof SessionSubtitleTrackSchema>;

export const SessionSubtitleListSchema = z
  .object({
    subtitles: z.array(SessionSubtitleTrackSchema).meta({ description: 'In collection order.' }),
    addons: z.array(AddonStatusSchema).meta({
      description: 'Every addon that was asked, in collection order.',
    }),
  })
  .meta({ id: 'SessionSubtitleList' });
export type SessionSubtitleList = z.infer<typeof SessionSubtitleListSchema>;
