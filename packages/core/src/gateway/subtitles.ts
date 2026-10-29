/**
 * Addon subtitles for a playback session (okf:architecture/core-subtitles-and-player-state, okf:architecture/media-gateway), on top of
 * the subtitle service: tracks with media-relative paths
 * (`ext/sub/{fileId}.vtt`), and files served only when they were listed for
 * the session's own item, so one session's token can't fetch another item's
 * files.
 */
import type { SessionItem, SessionSubtitleList, SessionSubtitleTrack } from '@multitap/api';
import type { Clock } from '../lib/clock.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import {
  clampSubtitleOffset,
  SUBTITLE_FILE_TTL_MS,
  SubtitleFileError,
  type SubtitleHints,
  type SubtitleService,
} from '../subtitles/index.ts';

/** Items whose listed file ids are remembered. */
export const SESSION_SUBTITLE_ITEMS = 2_000;

/** The media-relative path of a subtitle file (okf:architecture/media-gateway). */
export const sessionSubtitlePath = (fileId: string) => `ext/sub/${fileId}.vtt`;

const itemKey = (item: SessionItem) => `${item.type}\u0000${item.videoId ?? item.id}`;

export class SessionSubtitles {
  readonly #subtitles: Pick<SubtitleService, 'list' | 'file'>;
  readonly #repo: Pick<SessionRepository, 'listSubtitleOffsets' | 'setSubtitleOffset'>;
  /** Item → file ids listed for it. */
  readonly #listed: TtlCache<Set<string>>;

  constructor(deps: {
    subtitles: Pick<SubtitleService, 'list' | 'file'>;
    repo: Pick<SessionRepository, 'listSubtitleOffsets' | 'setSubtitleOffset'>;
    clock: Clock;
  }) {
    this.#subtitles = deps.subtitles;
    this.#repo = deps.repo;
    this.#listed = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_FILE_TTL_MS,
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
    this.#listed.set(itemKey(item), new Set(list.subtitles.map((t) => t.id)));
    const offsets =
      sessionId === undefined
        ? new Map<string, number>()
        : await this.#repo.listSubtitleOffsets(sessionId);
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

  /** Whether the file is listed for the item (listing again once when nothing is remembered). */
  async has(item: SessionItem, fileId: string): Promise<boolean> {
    let ids = this.#listed.get(itemKey(item));
    if (ids === undefined) {
      await this.list(item);
      ids = this.#listed.get(itemKey(item));
    }
    return ids?.has(fileId) === true;
  }

  /** Sets the session's offset for a file (0 clears it), clamped; returns the stored value. */
  async setOffset(sessionId: string, fileId: string, offsetMs: number): Promise<number> {
    const clamped = clampSubtitleOffset(offsetMs);
    await this.#repo.setSubtitleOffset(sessionId, fileId, clamped);
    return clamped;
  }

  /**
   * A file of the item's as WebVTT, shifted by the session's offset for it
   * plus `requestOffsetMs` (the sum clamped). A file id not listed for this
   * item is `not-found`. When nothing is remembered for the item (Multitap
   * restarted, or the list expired) it's listed again once.
   *
   * @throws {SubtitleFileError}
   */
  async file(
    sessionId: string,
    item: SessionItem,
    fileId: string,
    requestOffsetMs = 0,
  ): Promise<string> {
    if (!(await this.has(item, fileId))) {
      throw new SubtitleFileError(
        'not-found',
        "No subtitle file with this id for this session's item.",
      );
    }
    const stored = (await this.#repo.listSubtitleOffsets(sessionId)).get(fileId) ?? 0;
    return this.#subtitles.file(fileId, clampSubtitleOffset(stored + requestOffsetMs));
  }
}
