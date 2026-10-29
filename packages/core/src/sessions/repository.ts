/**
 * Persistence contract for playback sessions and their token revocations
 * (okf:architecture/playback-session, okf:concept/media-tokens, okf:architecture/engine-retention, okf:architecture/core-persistence). Implemented over the
 * `playback_sessions` and `token_revocations` tables by
 * `SqliteSessionRepository` (sessions/sqlite-repository.ts).
 *
 * Records use camelCase and Unix-millisecond times. The raw `Stream` is a
 * secret column: it is written with {@link SessionRepository.setChosen} and read
 * only through {@link SessionRepository.getStream}, never as part of a record,
 * so no view or log built from a record can leak it (okf:architecture/secrets-policy).
 */
import type {
  Delivery,
  HighResPolicy,
  PlaybackSessionStatus,
  SessionItem,
  SessionMode,
  SessionQuality,
  SessionSource,
  SessionTracks,
  SourceCandidate,
} from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';

export interface PlaybackSessionRecord {
  id: string;
  key: string | null;
  item: SessionItem;
  source: SessionSource;
  /** Idempotency identity (`sessionIdentity()` in sessions/identity.ts); null without a key. */
  identity: string | null;
  candidates: SourceCandidate[] | null;
  chosenKey: string | null;
  engineId: string | null;
  sid: string | null;
  delivery: Delivery;
  mode: SessionMode;
  highRes: HighResPolicy;
  /** As requested after capping; part of the identity. */
  requestedQuality: SessionQuality | null;
  /** What the engine applied (okf:architecture/rendition-and-bandwidth). */
  quality: SessionQuality | null;
  readyBy: number | null;
  retainUntil: number | null;
  status: PlaybackSessionStatus;
  failureReason: string | null;
  tokenEpoch: number;
  createdAt: number;
  updatedAt: number;
  lastAccess: number;
  releasedAt: number | null;
  /** The playing source's tracks, from the engine's probe; set with the chosen source. */
  tracks: SessionTracks | null;
  /** Index into `tracks.audio` to start with; set with the chosen source. */
  audioTrack: number | null;
  /** The playing source's `bingeGroup`; set with the chosen source. */
  bingeGroup: string | null;
  /** The profile the session was created for (its `lastSource` is recorded when ready). */
  profileId: string | null;
}

/** Fields fixed at creation. Status starts at `resolving`, epoch at 0. */
export type NewPlaybackSession = Pick<
  PlaybackSessionRecord,
  | 'id'
  | 'key'
  | 'item'
  | 'source'
  | 'identity'
  | 'candidates'
  | 'engineId'
  | 'delivery'
  | 'mode'
  | 'highRes'
  | 'requestedQuality'
  | 'readyBy'
  | 'retainUntil'
> & { profileId?: string | null };

/** Fields that change after creation (never the identity, source, delivery or quality request). */
export type PlaybackSessionPatch = Partial<
  Pick<
    PlaybackSessionRecord,
    | 'status'
    | 'failureReason'
    | 'engineId'
    | 'sid'
    | 'quality'
    | 'candidates'
    | 'readyBy'
    | 'retainUntil'
    | 'releasedAt'
  >
>;

export interface ChosenSource {
  chosenKey: string;
  /** Secret: stored in `stream_json` only. */
  stream: Stream;
  engineId: string;
  sid: string;
  quality: SessionQuality | null;
  tracks: SessionTracks | null;
  audioTrack: number | null;
  bingeGroup: string | null;
}

export interface TokenRevocation {
  sessionId: string;
  subject: string;
  /** Kept until the last token for this subject could have expired. */
  until: number;
}

export interface SessionRepository {
  create(session: NewPlaybackSession, now: number): Promise<PlaybackSessionRecord>;
  get(id: string): Promise<PlaybackSessionRecord | undefined>;
  /** The open (not `failed` or `released`) session with this identity, if any (okf:architecture/playback-session). */
  findOpenByIdentity(identity: string): Promise<PlaybackSessionRecord | undefined>;
  update(
    id: string,
    patch: PlaybackSessionPatch,
    now: number,
  ): Promise<PlaybackSessionRecord | undefined>;
  /** Records the candidate that is playing, with its raw stream (secret) and engine session. */
  setChosen(id: string, chosen: ChosenSource, now: number): Promise<void>;
  /** The chosen raw stream. Only the session service reads it, to hand to the engine module. */
  getStream(id: string): Promise<Stream | undefined>;
  /** Moves `last_access` forward (media requests, reads); cheap and idempotent. */
  touch(id: string, at: number): Promise<void>;
  /** The session's subtitle timing offsets by file id (files with offset 0 are absent). */
  listSubtitleOffsets(sessionId: string): Promise<Map<string, number>>;
  /** Sets a file's offset for the session; 0 removes it. */
  setSubtitleOffset(sessionId: string, fileId: string, offsetMs: number): Promise<void>;
  /** Bumps `token_epoch` and returns the new value; undefined for an unknown session. */
  bumpTokenEpoch(id: string, now: number): Promise<number | undefined>;
  /**
   * Sessions not yet released (failed ones included) due for release at
   * `now`: `max(retainUntil, lastAccess + idleMs) <= now` (okf:architecture/engine-retention).
   */
  listDueForRelease(now: number, idleMs: number): Promise<PlaybackSessionRecord[]>;
  /** Session counts by status (the `multitap_sessions_status` gauge). */
  countByStatus(): Promise<Map<string, number>>;
  /** Sessions not yet released (for startup and the gateway's in-memory state). */
  listOpen(): Promise<PlaybackSessionRecord[]>;
  /** Deletes released sessions released before `before`; returns how many. */
  purgeReleased(before: number): Promise<number>;

  revokeSubject(revocation: TokenRevocation): Promise<void>;
  /** Revocations still in force at `now` (loaded into memory at startup). */
  listRevocations(now: number): Promise<TokenRevocation[]>;
  /** Deletes revocations that ended before `now`; returns how many. */
  purgeRevocations(now: number): Promise<number>;
}
