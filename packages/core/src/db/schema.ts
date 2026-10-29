import type { Generated, Selectable } from 'kysely';

/**
 * Multitap's SQLite schema (okf:architecture/core-persistence), as produced by packages/core/migrations.
 * Timestamps are integer Unix milliseconds. Booleans are 0/1 integers.
 */
export interface Database {
  addons: AddonsTable;
  engines: EnginesTable;
  api_keys: ApiKeysTable;
  playback_sessions: PlaybackSessionsTable;
  engine_sessions: EngineSessionsTable;
  token_revocations: TokenRevocationsTable;
  session_subtitle_offsets: SessionSubtitleOffsetsTable;
  profiles: ProfilesTable;
  library_items: LibraryItemsTable;
  last_sources: LastSourcesTable;
  item_player_states: ItemPlayerStatesTable;
  settings: SettingsTable;
}

/**
 * Columns that hold secrets (okf:architecture/secrets-policy): addon manifest URLs, raw addon `Stream`s,
 * engine `mediaURL`s and engine proxy passwords. They never appear in an API view, and log
 * serializers redact them at `info` and above. Select through the
 * `*_PUBLIC_COLUMNS` lists below unless the secret itself is needed.
 */
export const SECRET_COLUMNS = {
  addons: ['manifest_url'],
  engines: ['proxy_password'],
  playback_sessions: ['stream_json'],
  engine_sessions: ['media_url'],
} as const satisfies { [T in keyof Database]?: readonly (keyof Database[T] & string)[] };

type SecretColumn<T extends keyof typeof SECRET_COLUMNS> = (typeof SECRET_COLUMNS)[T][number];

/** Every `playback_sessions` column but the secret ones; a test keeps this complete. */
export const PLAYBACK_SESSION_PUBLIC_COLUMNS = [
  'id',
  'key',
  'item_type',
  'item_id',
  'video_id',
  'source_json',
  'identity',
  'candidates_json',
  'chosen_key',
  'engine_id',
  'sid',
  'delivery',
  'mode',
  'high_res',
  'requested_quality_json',
  'quality_json',
  'ready_by',
  'retain_until',
  'status',
  'failure_reason',
  'token_epoch',
  'created_at',
  'updated_at',
  'last_access',
  'released_at',
  'tracks_json',
  'audio_track',
  'binge_group',
  'profile_id',
] as const satisfies readonly Exclude<
  keyof PlaybackSessionsTable,
  SecretColumn<'playback_sessions'>
>[];

/** Every `engines` column but the secret ones; a test keeps this complete. */
export const ENGINE_PUBLIC_COLUMNS = [
  'id',
  'name',
  'transport',
  'address',
  'capabilities_json',
  'last_seen',
  'local_addon',
] as const satisfies readonly Exclude<keyof EnginesTable, SecretColumn<'engines'>>[];

/** Every `engine_sessions` column but the secret ones; a test keeps this complete. */
export const ENGINE_SESSION_PUBLIC_COLUMNS = [
  'sid',
  'engine_id',
  'session_key',
  'stream_hash',
  'quality_key',
  'applied_quality_json',
  'created_at',
  'last_used',
  'release_pending_since',
  'release_attempts',
  'release_next_at',
] as const satisfies readonly Exclude<keyof EngineSessionsTable, SecretColumn<'engine_sessions'>>[];

export interface AddonsTable {
  id: string;
  /** Secret: manifest URLs embed debrid and other keys (okf:architecture/secrets-policy). Never logged or returned. */
  manifest_url: string;
  enabled: Generated<number>;
  /** Addon order (okf:concept/addon-aggregation); lower first. */
  position: number;
  manifest_json: string;
  manifest_fetched_at: number;
  created_at: number;
}

export interface EnginesTable {
  id: string;
  name: string;
  transport: string;
  address: string | null;
  capabilities_json: string;
  last_seen: number | null;
  /** 0/1 (migration 0002). */
  local_addon: Generated<number>;
  /**
   * Secret (migration 0006): the engine's `STREMIO_PROXY_PASSWORD`, sent as
   * `api_password` on `/proxy/stream` URLs (okf:architecture/secrets-classes-and-engine-password). Null = none. Write-only over
   * the API; never logged.
   */
  proxy_password: string | null;
}

export type ApiKeyScope = 'client' | 'admin' | 'metrics';

export interface ApiKeysTable {
  id: string;
  /** SHA-256 of the key, lowercase hex. The key itself is never stored. */
  key_hash: string;
  scope: ApiKeyScope;
  label: string;
  created_at: number;
  last_used: number | null;
  revoked_at: number | null;
}

export type ApiKeyRow = Selectable<ApiKeysTable>;

// ---- Phase 2 (migration 0003) ------------------------------------------------

export type PlaybackSessionStatusValue =
  'resolving' | 'preparing' | 'ready' | 'failed' | 'released';
export type DeliveryValue = 'direct' | 'remux' | 'transcode';
export type SessionModeValue = 'play' | 'full';
export type HighResValue = 'off' | 'prepareOnly' | 'on';

/** A playback session (okf:architecture/playback-session). Enum values match `@multitap/api`'s `PlaybackSession`. */
export interface PlaybackSessionsTable {
  /** `ps_` + random. */
  id: string;
  /** The client's grouping key (okf:architecture/playback-session); null when the create had none. */
  key: string | null;
  item_type: string;
  item_id: string;
  video_id: string | null;
  /** The request's `source` as JSON: `{"key":…}` or `{"auto":true}`. */
  source_json: string;
  /**
   * Idempotency identity: a hash of key, item, source, requested delivery and
   * requested quality. Null without a key (every create is new).
   */
  identity: string | null;
  /** Auto-select only: the fallback order, `SourceCandidate[]` as JSON. */
  candidates_json: string | null;
  /** The candidate key actually playing. */
  chosen_key: string | null;
  /** Secret: the chosen raw addon `Stream` as JSON (okf:architecture/secrets-policy). Never returned or logged. */
  stream_json: string | null;
  engine_id: string | null;
  /** The engine session id (okf:architecture/engine-prepare-stream). */
  sid: string | null;
  delivery: DeliveryValue;
  mode: SessionModeValue;
  high_res: HighResValue;
  /** `{maxHeight?, bitrate?}` as requested (after capping), part of the identity. */
  requested_quality_json: string | null;
  /** `{maxHeight?, bitrate?}` the engine applied; null when none was (okf:architecture/rendition-and-bandwidth). */
  quality_json: string | null;
  ready_by: number | null;
  retain_until: number | null;
  status: PlaybackSessionStatusValue;
  /** Coarse reason for `failed`. */
  failure_reason: string | null;
  token_epoch: Generated<number>;
  created_at: number;
  updated_at: number;
  last_access: number;
  released_at: number | null;
  /** The playing source's audio and subtitle tracks (`SessionTracks` as JSON), once ready. */
  tracks_json: string | null;
  /** Index into the tracks' `audio` to start with (the request's audio language), once ready. */
  audio_track: number | null;
  /** The playing source's `behaviorHints.bingeGroup`, once ready. */
  binge_group: string | null;
  /** The create request's `profileId` (migration 0009); no foreign key. */
  profile_id: string | null;
}

export type PlaybackSessionRow = Selectable<PlaybackSessionsTable>;

/** An engine session (okf:architecture/engine-prepare-stream), owned by the engine module. */
export interface EngineSessionsTable {
  /** 22-char base64url, minted by Multitap. */
  sid: string;
  engine_id: string;
  /** The playback session id, opaque to the engine module. */
  session_key: string;
  stream_hash: string;
  /** Canonical quality overrides ('' for none); part of the lookup (okf:architecture/rendition-and-bandwidth). */
  quality_key: Generated<string>;
  /** The overrides the engine applied, `{maxHeight?, bitrate?}` as JSON. */
  applied_quality_json: string | null;
  /** Secret: the engine `mediaURL`, which can embed debrid tokens (okf:architecture/secrets-policy). */
  media_url: string;
  created_at: number;
  last_used: number;
  /**
   * Set when Multitap released the session but the engine's `DELETE` failed
   * (migration 0007, okf:architecture/engine-retention): the retention sweep retries until the engine
   * confirms the session is gone, then deletes the row. Null = in use.
   */
  release_pending_since: number | null;
  /** Failed release attempts so far (backoff). */
  release_attempts: Generated<number>;
  /** When the next release attempt is due, Unix ms. */
  release_next_at: number | null;
}

export type EngineSessionRow = Selectable<EngineSessionsTable>;

/** A per-subject media token revocation (okf:concept/media-tokens), kept until `until`. */
export interface TokenRevocationsTable {
  session_id: string;
  subject: string;
  until: number;
}

/** A session's timing offset for one subtitle file (migration 0010); no row = 0. */
export interface SessionSubtitleOffsetsTable {
  session_id: string;
  file_id: string;
  offset_ms: number;
}

export interface ProfilesTable {
  id: string;
  name: string;
  created_at: number;
  /**
   * The stored `ProfileSettings` fields, sparse (migration 0009); null = all
   * defaults. Read merged over `DEFAULT_PROFILE_SETTINGS`.
   */
  settings_json: string | null;
}

/**
 * A stremio-core `LibraryItem` (okf:architecture/library-and-profiles). `state_json` and `behavior_hints_json`
 * hold `LibraryItemState` and `MetaItemBehaviorHints` in stremio-core's own
 * serialized field names; `@multitap/api`'s `LibraryItem` is the shape.
 */
export interface LibraryItemsTable {
  profile_id: string;
  /** stremio-core's `_id`: the meta id (`tt0903747`). */
  item_id: string;
  type: string;
  name: string;
  poster: string | null;
  poster_shape: Generated<string>;
  removed: Generated<number>;
  temp: Generated<number>;
  state_json: string;
  behavior_hints_json: string;
  ctime: number | null;
  mtime: number;
}

export type LibraryItemRow = Selectable<LibraryItemsTable>;

/**
 * The source a profile last played per item (migration 0009, gap analysis
 * §2.3), written when a session created for the profile becomes ready. No
 * secrets: `source_identity` is the candidate key (a hash), the rest is what a
 * source list shows.
 */
export interface LastSourcesTable {
  profile_id: string;
  item_id: string;
  video_id: string;
  source_identity: string;
  addon_id: string;
  addon_name: string;
  name: string;
  title: string;
  binge_group: string | null;
  played_at: number;
}

export type LastSourceRow = Selectable<LastSourcesTable>;

/**
 * A profile's player choices for an item (migration 0011, phase 3 P1),
 * stremio-core's `StreamItemState`: one row per (profile, item), like
 * `last_sources`. Non-secret.
 */
export interface ItemPlayerStatesTable {
  profile_id: string;
  item_id: string;
  /** ISO 639 code; null = no choice. */
  audio_language: string | null;
  /** `ItemSubtitleChoice` as JSON; null = no choice. */
  subtitle_json: string | null;
  subtitle_offset_ms: Generated<number>;
  playback_speed: number | null;
  updated_at: number;
}

export type ItemPlayerStateRow = Selectable<ItemPlayerStatesTable>;

/** Operator overrides of built-in defaults, by key (e.g. `ranking`, okf:concept/ranking-settings). */
export interface SettingsTable {
  key: string;
  value_json: string;
  updated_at: number;
}
