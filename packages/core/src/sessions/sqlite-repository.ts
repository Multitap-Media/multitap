/**
 * {@link SessionRepository} over the `playback_sessions` and
 * `token_revocations` tables (okf:architecture/playback-session, okf:concept/media-tokens, okf:architecture/engine-retention, okf:architecture/core-persistence).
 *
 * Records are read through `PLAYBACK_SESSION_PUBLIC_COLUMNS`, so the secret
 * `stream_json` column never reaches a record; only {@link getStream} reads it.
 */
import type {
  SessionItem,
  SessionQuality,
  SessionSource,
  SessionTracks,
  SourceCandidate,
} from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';
import { sql, type Selectable, type Updateable } from 'kysely';
import type { Db } from '../db/index.ts';
import { PLAYBACK_SESSION_PUBLIC_COLUMNS, type PlaybackSessionsTable } from '../db/schema.ts';
import type {
  ChosenSource,
  NewPlaybackSession,
  PlaybackSessionPatch,
  PlaybackSessionRecord,
  SessionRepository,
  TokenRevocation,
} from './repository.ts';

type PublicRow = Pick<
  Selectable<PlaybackSessionsTable>,
  (typeof PLAYBACK_SESSION_PUBLIC_COLUMNS)[number]
>;

const parse = (json: string | null): unknown => (json === null ? null : JSON.parse(json));
const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

function fromRow(row: PublicRow): PlaybackSessionRecord {
  const item: SessionItem = { type: row.item_type, id: row.item_id };
  if (row.video_id !== null) item.videoId = row.video_id;
  return {
    id: row.id,
    key: row.key,
    item,
    source: JSON.parse(row.source_json) as SessionSource,
    identity: row.identity,
    candidates: parse(row.candidates_json) as SourceCandidate[] | null,
    chosenKey: row.chosen_key,
    engineId: row.engine_id,
    sid: row.sid,
    delivery: row.delivery,
    mode: row.mode,
    highRes: row.high_res,
    requestedQuality: parse(row.requested_quality_json) as SessionQuality | null,
    quality: parse(row.quality_json) as SessionQuality | null,
    readyBy: row.ready_by,
    retainUntil: row.retain_until,
    status: row.status,
    failureReason: row.failure_reason,
    tokenEpoch: row.token_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccess: row.last_access,
    releasedAt: row.released_at,
    tracks: parse(row.tracks_json) as SessionTracks | null,
    audioTrack: row.audio_track,
    bingeGroup: row.binge_group,
    profileId: row.profile_id,
  };
}

/** The patch as column values; keys left out stay unchanged. */
function patchColumns(patch: PlaybackSessionPatch): Updateable<PlaybackSessionsTable> {
  const set: Updateable<PlaybackSessionsTable> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.failureReason !== undefined) set.failure_reason = patch.failureReason;
  if (patch.engineId !== undefined) set.engine_id = patch.engineId;
  if (patch.sid !== undefined) set.sid = patch.sid;
  if (patch.quality !== undefined) set.quality_json = json(patch.quality);
  if (patch.candidates !== undefined) set.candidates_json = json(patch.candidates);
  if (patch.readyBy !== undefined) set.ready_by = patch.readyBy;
  if (patch.retainUntil !== undefined) set.retain_until = patch.retainUntil;
  if (patch.releasedAt !== undefined) set.released_at = patch.releasedAt;
  return set;
}

export class SqliteSessionRepository implements SessionRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #select() {
    return this.#db.selectFrom('playback_sessions').select(PLAYBACK_SESSION_PUBLIC_COLUMNS);
  }

  async create(session: NewPlaybackSession, now: number): Promise<PlaybackSessionRecord> {
    await this.#db
      .insertInto('playback_sessions')
      .values({
        id: session.id,
        key: session.key,
        item_type: session.item.type,
        item_id: session.item.id,
        video_id: session.item.videoId ?? null,
        source_json: JSON.stringify(session.source),
        identity: session.identity,
        candidates_json: json(session.candidates),
        chosen_key: null,
        stream_json: null,
        engine_id: session.engineId,
        sid: null,
        delivery: session.delivery,
        mode: session.mode,
        high_res: session.highRes,
        requested_quality_json: json(session.requestedQuality),
        quality_json: null,
        ready_by: session.readyBy,
        retain_until: session.retainUntil,
        status: 'resolving',
        failure_reason: null,
        token_epoch: 0,
        created_at: now,
        updated_at: now,
        last_access: now,
        released_at: null,
        tracks_json: null,
        audio_track: null,
        binge_group: null,
        profile_id: session.profileId ?? null,
      })
      .execute();
    const created = await this.get(session.id);
    if (created === undefined) throw new Error('playback session vanished after insert');
    return created;
  }

  async get(id: string): Promise<PlaybackSessionRecord | undefined> {
    const row = await this.#select().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  }

  async findOpenByIdentity(identity: string): Promise<PlaybackSessionRecord | undefined> {
    const row = await this.#select()
      .where('identity', '=', identity)
      .where('status', 'not in', ['failed', 'released'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  }

  async update(
    id: string,
    patch: PlaybackSessionPatch,
    now: number,
  ): Promise<PlaybackSessionRecord | undefined> {
    await this.#db
      .updateTable('playback_sessions')
      .set({ ...patchColumns(patch), updated_at: now })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  async setChosen(id: string, chosen: ChosenSource, now: number): Promise<void> {
    await this.#db
      .updateTable('playback_sessions')
      .set({
        chosen_key: chosen.chosenKey,
        stream_json: JSON.stringify(chosen.stream),
        engine_id: chosen.engineId,
        sid: chosen.sid,
        quality_json: json(chosen.quality),
        tracks_json: json(chosen.tracks),
        audio_track: chosen.audioTrack,
        binge_group: chosen.bingeGroup,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  async getStream(id: string): Promise<Stream | undefined> {
    const row = await this.#db
      .selectFrom('playback_sessions')
      .select('stream_json')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.stream_json == null ? undefined : (JSON.parse(row.stream_json) as Stream);
  }

  async touch(id: string, at: number): Promise<void> {
    await this.#db
      .updateTable('playback_sessions')
      .set({ last_access: at })
      .where('id', '=', id)
      .where('last_access', '<', at)
      .execute();
  }

  async listSubtitleOffsets(sessionId: string): Promise<Map<string, number>> {
    const rows = await this.#db
      .selectFrom('session_subtitle_offsets')
      .select(['file_id', 'offset_ms'])
      .where('session_id', '=', sessionId)
      .execute();
    return new Map(rows.map((row) => [row.file_id, row.offset_ms]));
  }

  async setSubtitleOffset(sessionId: string, fileId: string, offsetMs: number): Promise<void> {
    if (offsetMs === 0) {
      await this.#db
        .deleteFrom('session_subtitle_offsets')
        .where('session_id', '=', sessionId)
        .where('file_id', '=', fileId)
        .execute();
      return;
    }
    await this.#db
      .insertInto('session_subtitle_offsets')
      .values({ session_id: sessionId, file_id: fileId, offset_ms: offsetMs })
      .onConflict((oc) =>
        oc.columns(['session_id', 'file_id']).doUpdateSet({ offset_ms: offsetMs }),
      )
      .execute();
  }

  async bumpTokenEpoch(id: string, now: number): Promise<number | undefined> {
    const row = await this.#db
      .updateTable('playback_sessions')
      .set((eb) => ({ token_epoch: eb('token_epoch', '+', 1), updated_at: now }))
      .where('id', '=', id)
      .returning('token_epoch')
      .executeTakeFirst();
    return row?.token_epoch;
  }

  /**
   * Sessions not yet released whose retention ended: `max(retainUntil,
   * lastAccess + idleMs) <= now` (okf:architecture/engine-retention). Failed sessions are included, so they
   * too end as `released` and are purged later.
   */
  async listDueForRelease(now: number, idleMs: number): Promise<PlaybackSessionRecord[]> {
    const rows = await this.#select()
      .where('status', '!=', 'released')
      .where(sql<number>`max(coalesce(retain_until, 0), last_access + ${idleMs})`, '<=', now)
      .orderBy('created_at')
      .execute();
    return rows.map(fromRow);
  }

  async listOpen(): Promise<PlaybackSessionRecord[]> {
    const rows = await this.#select()
      .where('status', '!=', 'released')
      .orderBy('created_at')
      .execute();
    return rows.map(fromRow);
  }

  async purgeReleased(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('playback_sessions')
      .where('status', '=', 'released')
      .where('released_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Counts by status, for the `multitap_sessions_status` gauge. */
  async countByStatus(): Promise<Map<string, number>> {
    const rows = await this.#db
      .selectFrom('playback_sessions')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .groupBy('status')
      .execute();
    return new Map(rows.map((row) => [row.status, row.n]));
  }

  async revokeSubject(revocation: TokenRevocation): Promise<void> {
    // A later revocation of the same subject extends it; never shortens it.
    const existing = await this.#db
      .selectFrom('token_revocations')
      .select('until')
      .where('session_id', '=', revocation.sessionId)
      .where('subject', '=', revocation.subject)
      .executeTakeFirst();
    if (existing === undefined) {
      await this.#db
        .insertInto('token_revocations')
        .values({
          session_id: revocation.sessionId,
          subject: revocation.subject,
          until: revocation.until,
        })
        .execute();
    } else if (existing.until < revocation.until) {
      await this.#db
        .updateTable('token_revocations')
        .set({ until: revocation.until })
        .where('session_id', '=', revocation.sessionId)
        .where('subject', '=', revocation.subject)
        .execute();
    }
  }

  async listRevocations(now: number): Promise<TokenRevocation[]> {
    const rows = await this.#db
      .selectFrom('token_revocations')
      .select(['session_id', 'subject', 'until'])
      .where('until', '>', now)
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      subject: row.subject,
      until: row.until,
    }));
  }

  async purgeRevocations(now: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('token_revocations')
      .where('until', '<=', now)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
