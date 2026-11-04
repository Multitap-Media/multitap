/**
 * Addon subtitles for a playback session (okf:architecture/core-subtitles-and-player-state, okf:architecture/media-gateway), on top of
 * the subtitle service: tracks with media-relative paths
 * (`ext/sub/{fileId}.vtt`), and files served only when they were listed for
 * the session's own item, so one session's token can't fetch another item's
 * files.
 *
 * Every listing of an item adds its file ids to what is remembered for the
 * item (two sessions of one item, with different files and so different
 * hints, each keep their tracks). A listing made because nothing is
 * remembered (a restart, the 6 h expiry) or because the subtitle service
 * forgot a file uses the session's own hints, so hash-matched tracks come back;
 * concurrent ones share one listing.
 */
import type { SessionItem, SessionSubtitleList, SessionSubtitleTrack } from '@multitap/api';
import type { Clock } from '../lib/clock.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { PlaybackSessionRecord, SessionRepository } from '../sessions/repository.ts';
import {
  clampSubtitleOffset,
  SUBTITLE_FILE_TTL_MS,
  SubtitleFileError,
  type SubtitleHints,
  type SubtitleService,
} from '../subtitles/index.ts';

/** Items whose listed file ids are remembered. */
export const SESSION_SUBTITLE_ITEMS = 2_000;
/** File ids remembered per item; the oldest listed go first. */
export const SESSION_SUBTITLE_FILES_PER_ITEM = 2_000;
/** Sessions remembered per item as having listed it. */
const SESSIONS_PER_ITEM = 1_000;
/** How long a session's subtitle offsets are kept in memory (written through on change). */
export const SESSION_SUBTITLE_OFFSETS_TTL_MS = 60_000;

/** The media-relative path of a subtitle file (okf:architecture/media-gateway). */
export const sessionSubtitlePath = (fileId: string) => `ext/sub/${fileId}.vtt`;

const itemKey = (item: SessionItem) => `${item.type}\u0000${item.videoId ?? item.id}`;

/** What is remembered for an item. */
interface Listed {
  /** Every file id listed for the item, in listing order. */
  ids: Set<string>;
  /** Sessions whose own listing (with their hints) is part of {@link ids}. */
  sessions: Set<string>;
}

export class SessionSubtitles {
  readonly #subtitles: Pick<SubtitleService, 'list' | 'file'>;
  readonly #repo: Pick<SessionRepository, 'listSubtitleOffsets' | 'setSubtitleOffset'>;
  readonly #hints: (session: PlaybackSessionRecord) => Promise<SubtitleHints>;
  /** Item → file ids listed for it. */
  readonly #listed: TtlCache<Listed>;
  /** Item and session → the listing in flight for it. */
  readonly #inFlight = new Map<string, Promise<ReadonlySet<string>>>();
  /** Session id → its offsets. */
  readonly #offsets: TtlCache<Map<string, number>>;
  /** Bumped by every offset write, so a read that raced one isn't cached. */
  #offsetWrites = 0;

  constructor(deps: {
    subtitles: Pick<SubtitleService, 'list' | 'file'>;
    repo: Pick<SessionRepository, 'listSubtitleOffsets' | 'setSubtitleOffset'>;
    clock: Clock;
    /** The session's `videoHash`/`videoSize`/`filename` (`SessionService.subtitleHints`); none without it. */
    hints?: ((session: PlaybackSessionRecord) => Promise<SubtitleHints>) | undefined;
  }) {
    this.#subtitles = deps.subtitles;
    this.#repo = deps.repo;
    this.#hints = deps.hints ?? (() => Promise.resolve({}));
    this.#listed = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_FILE_TTL_MS,
      maxEntries: SESSION_SUBTITLE_ITEMS,
    });
    this.#offsets = new TtlCache({
      clock: deps.clock,
      ttlMs: SESSION_SUBTITLE_OFFSETS_TTL_MS,
      maxEntries: SESSION_SUBTITLE_ITEMS,
    });
  }

  /**
   * The item's addon subtitles, with paths under `/media/{token}/` and, given
   * the session, each track's session offset.
   */
  async list(
    item: SessionItem,
    hints?: SubtitleHints,
    sessionId?: string,
  ): Promise<SessionSubtitleList> {
    const list = await this.#subtitles.list(item.type, item.videoId ?? item.id, hints);
    this.#remember(
      item,
      list.subtitles.map((t) => t.id),
      sessionId,
    );
    const offsets =
      sessionId === undefined ? new Map<string, number>() : await this.#offsetsOf(sessionId);
    return {
      subtitles: list.subtitles.map((t) => {
        const track: SessionSubtitleTrack = {
          id: t.id,
          lang: t.lang,
          addonId: t.addonId,
          path: sessionSubtitlePath(t.id),
          offsetMs: offsets.get(t.id) ?? 0,
        };
        if (t.label !== undefined) track.label = t.label;
        return track;
      }),
      addons: list.addons,
    };
  }

  /**
   * Whether the file is listed for the session's item. When it isn't and this
   * session's own listing isn't remembered (Multitap restarted, the list
   * expired, or only other sessions listed the item), the item is listed again
   * once, with the session's hints.
   */
  async has(session: PlaybackSessionRecord, fileId: string): Promise<boolean> {
    const listed = this.#listed.get(itemKey(session.item));
    if (listed?.ids.has(fileId) === true) return true;
    if (listed?.sessions.has(session.id) === true) return false;
    return (await this.#relist(session)).has(fileId);
  }

  /** Sets the session's offset for a file (0 clears it), clamped; returns the stored value. */
  async setOffset(sessionId: string, fileId: string, offsetMs: number): Promise<number> {
    const clamped = clampSubtitleOffset(offsetMs);
    this.#offsetWrites += 1;
    this.#offsets.delete(sessionId);
    try {
      await this.#repo.setSubtitleOffset(sessionId, fileId, clamped);
    } finally {
      // Whatever was read meanwhile may predate the write.
      this.#offsetWrites += 1;
      this.#offsets.delete(sessionId);
    }
    return clamped;
  }

  /**
   * A file of the item's as WebVTT, shifted by the session's offset for it
   * plus `requestOffsetMs` (the sum clamped). A file id not listed for this
   * item is `not-found`. When nothing is remembered for the item (Multitap
   * restarted, or the list expired), or the subtitle service no longer knows
   * the file, it's listed again once, with the session's hints.
   *
   * @throws {SubtitleFileError}
   */
  async file(session: PlaybackSessionRecord, fileId: string, requestOffsetMs = 0): Promise<string> {
    if (!(await this.has(session, fileId))) {
      throw new SubtitleFileError(
        'not-found',
        "No subtitle file with this id for this session's item.",
      );
    }
    const stored = (await this.#offsetsOf(session.id)).get(fileId) ?? 0;
    const offsetMs = clampSubtitleOffset(stored + requestOffsetMs);
    try {
      return await this.#subtitles.file(fileId, offsetMs);
    } catch (err) {
      if (!(err instanceof SubtitleFileError) || err.code !== 'not-found') throw err;
      // The service forgot the file's URL (evicted or expired): list again.
      if (!(await this.#relist(session)).has(fileId)) {
        this.#listed.get(itemKey(session.item))?.ids.delete(fileId);
        throw err;
      }
      return this.#subtitles.file(fileId, offsetMs);
    }
  }

  /** Lists the session's item with its hints (one listing at a time per item and session); the ids listed. */
  #relist(session: PlaybackSessionRecord): Promise<ReadonlySet<string>> {
    const key = `${itemKey(session.item)}\u0000${session.id}`;
    let pending = this.#inFlight.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const hints = await this.#hints(session);
        const { item } = session;
        const list = await this.#subtitles.list(item.type, item.videoId ?? item.id, hints);
        const ids = list.subtitles.map((t) => t.id);
        this.#remember(item, ids, session.id);
        return new Set(ids);
      })().finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, pending);
    }
    return pending;
  }

  /** Adds a listing's file ids to the item's, bounded, and refreshes the item's expiry. */
  #remember(item: SessionItem, ids: readonly string[], sessionId: string | undefined): void {
    const key = itemKey(item);
    const listed = this.#listed.get(key) ?? { ids: new Set<string>(), sessions: new Set<string>() };
    for (const id of ids) {
      listed.ids.delete(id);
      listed.ids.add(id);
    }
    for (const id of listed.ids) {
      if (listed.ids.size <= SESSION_SUBTITLE_FILES_PER_ITEM) break;
      listed.ids.delete(id);
    }
    if (sessionId !== undefined) {
      if (listed.sessions.size >= SESSIONS_PER_ITEM) listed.sessions.clear();
      listed.sessions.add(sessionId);
    }
    this.#listed.set(key, listed);
  }

  /** The session's offsets, from memory when read recently. */
  async #offsetsOf(sessionId: string): Promise<ReadonlyMap<string, number>> {
    const cached = this.#offsets.get(sessionId);
    if (cached !== undefined) return cached;
    const writes = this.#offsetWrites;
    const offsets = await this.#repo.listSubtitleOffsets(sessionId);
    if (writes === this.#offsetWrites) this.#offsets.set(sessionId, offsets);
    return offsets;
  }
}
