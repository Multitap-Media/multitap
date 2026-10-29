/**
 * Multitap's subtitles (okf:concept/addon-aggregation): addon subtitles aggregated like
 * streams, and served as WebVTT from `/v1/subtitles/file/{fileId}.vtt`.
 *
 * A subtitle's original URL can carry an addon's token, so it stays here: the
 * API hands out a file id, and Multitap fetches and converts the file itself.
 * The URL is the addon's choice, so the fetch and every redirect go through
 * the private-host guard (okf:architecture/addon-private-host-guard).
 */
import { createHash } from 'node:crypto';
import type { SubtitleList, SubtitleTrack } from '@multitap/api';
import {
  defaultPrivateHostGuard,
  type ExtraValue,
  type PrivateHostGuard,
} from '@multitap/addon-protocol';
import { addonStatus, type AddonService } from '../addons/index.ts';
import type { Clock } from '../auth/keys.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { Logger } from '../log.ts';
import { clampSubtitleOffset, shiftWebVtt, SubtitleFormatError, toWebVtt } from './convert.ts';

export {
  clampSubtitleOffset,
  decodeSubtitleBytes,
  detectFormat,
  shiftWebVtt,
  SUBTITLE_OFFSET_MAX_MS,
  SubtitleFormatError,
  toWebVtt,
} from './convert.ts';

/** Largest subtitle file Multitap fetches. */
export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;
export const SUBTITLE_FETCH_TIMEOUT_MS = 10_000;
/** How long a listed file id stays resolvable. */
export const SUBTITLE_FILE_TTL_MS = 6 * 3_600_000;
export const SUBTITLE_FILE_MAX_ENTRIES = 10_000;
/** Converted files are cached briefly, bounded by count and total size. */
export const SUBTITLE_VTT_TTL_MS = 10 * 60_000;
export const SUBTITLE_VTT_MAX_ENTRIES = 200;
export const SUBTITLE_VTT_MAX_BYTES = 50 * 1024 * 1024;

/** A file id: base64url, 32 characters. */
export const SUBTITLE_FILE_ID_PATTERN = '^[A-Za-z0-9_-]{32}$';

export type SubtitleFileErrorCode =
  'not-found' | 'timeout' | 'network' | 'http-status' | 'too-large' | 'format';

/** Why a subtitle file can't be served. Messages never contain its URL. */
export class SubtitleFileError extends Error {
  override name = 'SubtitleFileError';
  readonly code: SubtitleFileErrorCode;

  constructor(code: SubtitleFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface SubtitleSource {
  addonId: string;
  /** Secret: never logged or returned. */
  url: string;
}

/**
 * What identifies the video file, for addons that match subtitles by it (the
 * SDK's `videoHash`, `videoSize` and `filename` extras). All optional.
 */
export interface SubtitleHints {
  /** OpenSubtitles hash: 16 lower-case hex digits. */
  videoHash?: string | undefined;
  /** Bytes. */
  videoSize?: number | undefined;
  filename?: string | undefined;
}

/** The extras for `hints`, in stremio-core's order; nothing for absent hints. */
export function hintExtras(hints: SubtitleHints | undefined): ExtraValue[] {
  const extra: ExtraValue[] = [];
  if (hints?.videoHash !== undefined && hints.videoHash !== '') {
    extra.push({ name: 'videoHash', value: hints.videoHash });
  }
  if (hints?.videoSize !== undefined)
    extra.push({ name: 'videoSize', value: String(hints.videoSize) });
  if (hints?.filename !== undefined && hints.filename !== '') {
    extra.push({ name: 'filename', value: hints.filename });
  }
  return extra;
}

export interface SubtitleServiceDeps {
  addons: AddonService;
  clock: Clock;
  logger: Logger;
  /** Test seam. */
  fetch?: typeof globalThis.fetch;
  /** Refuses private hosts unless allowlisted; default: no allowlist. Multitap passes `AddonService.guard`. */
  guard?: PrivateHostGuard;
  /** `MULTITAP_SUBTITLE_MAX_BYTES` (config.subtitles); defaults to {@link SUBTITLE_MAX_BYTES}. */
  maxBytes?: number;
  /** `SUBTITLE_TIMEOUT_MS` (config.subtitles); defaults to {@link SUBTITLE_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The Multitap path a subtitle file is served from. */
export const subtitleFilePath = (fileId: string) => `/v1/subtitles/file/${fileId}.vtt`;

function fileIdFor(addonId: string, url: string): string {
  return createHash('sha256')
    .update(JSON.stringify([addonId, url]))
    .digest('base64url')
    .slice(0, 32);
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

export class SubtitleService {
  readonly #addons: AddonService;
  readonly #logger: Logger;
  readonly #fetch: typeof globalThis.fetch;
  readonly #guard: PrivateHostGuard;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #files: TtlCache<SubtitleSource>;
  readonly #vtt: TtlCache<string>;
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(deps: SubtitleServiceDeps) {
    this.#addons = deps.addons;
    this.#logger = deps.logger;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#guard = deps.guard ?? defaultPrivateHostGuard;
    this.#maxBytes = deps.maxBytes ?? SUBTITLE_MAX_BYTES;
    this.#timeoutMs = deps.timeoutMs ?? SUBTITLE_FETCH_TIMEOUT_MS;
    this.#files = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_FILE_TTL_MS,
      maxEntries: SUBTITLE_FILE_MAX_ENTRIES,
    });
    this.#vtt = new TtlCache({
      clock: deps.clock,
      ttlMs: SUBTITLE_VTT_TTL_MS,
      maxEntries: SUBTITLE_VTT_MAX_ENTRIES,
      maxWeight: SUBTITLE_VTT_MAX_BYTES,
      weigh: (text) => Buffer.byteLength(text, 'utf8'),
    });
  }

  /**
   * Every matching addon's subtitles, in collection order. Each file gets an
   * id that {@link file} resolves; a file listed twice by one addon is listed
   * once, and one with a non-http(s) URL is dropped. `hints` become the
   * `videoHash`/`videoSize`/`filename` extras of the addon request.
   */
  async list(type: string, videoId: string, hints?: SubtitleHints): Promise<SubtitleList> {
    const result = await this.#addons.aggregate('subtitles', type, videoId, hintExtras(hints));
    const seen = new Set<string>();
    const subtitles: SubtitleTrack[] = [];
    const addons = result.addons.map((outcome) => {
      let count = 0;
      let unusable = 0;
      for (const item of outcome.items) {
        if (!isHttpUrl(item.url)) {
          unusable++;
          continue;
        }
        const id = fileIdFor(outcome.addonId, item.url);
        if (seen.has(id)) continue;
        seen.add(id);
        this.#files.set(id, { addonId: outcome.addonId, url: item.url });
        const track: SubtitleTrack = {
          id,
          lang: item.lang,
          addonId: outcome.addonId,
          url: subtitleFilePath(id),
        };
        if (item.label !== undefined) track.label = item.label;
        subtitles.push(track);
        count++;
      }
      return addonStatus(outcome, count, unusable);
    });
    return { subtitles, addons };
  }

  /**
   * A listed file as WebVTT, fetched and converted on first use and cached
   * briefly. `offsetMs` shifts the cues (clamped to +-`SUBTITLE_OFFSET_MAX_MS`;
   * see `shiftWebVtt`). Only the unshifted conversion is cached, and the shift
   * is applied per request, so varying offsets can't grow the cache.
   *
   * @throws {SubtitleFileError}
   */
  async file(fileId: string, offsetMs = 0): Promise<string> {
    return shiftWebVtt(await this.#unshifted(fileId), clampSubtitleOffset(offsetMs));
  }

  async #unshifted(fileId: string): Promise<string> {
    const cached = this.#vtt.get(fileId);
    if (cached !== undefined) return cached;
    const source = this.#files.get(fileId);
    if (source === undefined) {
      throw new SubtitleFileError('not-found', 'No subtitle file with this id; list them again.');
    }
    let pending = this.#inFlight.get(fileId);
    if (pending === undefined) {
      pending = this.#load(fileId, source).finally(() => this.#inFlight.delete(fileId));
      this.#inFlight.set(fileId, pending);
    }
    return pending;
  }

  async #load(fileId: string, source: SubtitleSource): Promise<string> {
    const host = new URL(source.url).host;
    try {
      const vtt = toWebVtt(await this.#download(source.url));
      this.#vtt.set(fileId, vtt);
      return vtt;
    } catch (err) {
      const failure =
        err instanceof SubtitleFileError
          ? err
          : err instanceof SubtitleFormatError
            ? new SubtitleFileError('format', 'The subtitle file is in no supported format.')
            : new SubtitleFileError('network', 'The subtitle file could not be fetched.');
      this.#logger.warn(
        { addonId: source.addonId, host, code: failure.code },
        'subtitle file failed',
      );
      throw failure;
    }
  }

  async #download(url: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.#guard.fetch(
        url,
        { signal: AbortSignal.timeout(this.#timeoutMs), redirect: 'follow' },
        { fetch: this.#fetch },
      );
    } catch (err) {
      throw this.#fetchError(err);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SubtitleFileError(
        'http-status',
        `The subtitle file's server answered HTTP ${String(response.status)}.`,
      );
    }
    const tooLarge = () =>
      new SubtitleFileError(
        'too-large',
        `The subtitle file is larger than ${String(this.#maxBytes)} bytes.`,
      );
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > this.#maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (response.body === null) return new Uint8Array();
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.#maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (err) {
      throw err instanceof SubtitleFileError ? err : this.#fetchError(err);
    }
    return Buffer.concat(chunks);
  }

  #fetchError(err: unknown): SubtitleFileError {
    const name = err instanceof Error ? err.name : '';
    return name === 'TimeoutError' || name === 'AbortError'
      ? new SubtitleFileError('timeout', 'The subtitle file took too long to fetch.')
      : new SubtitleFileError('network', 'The subtitle file could not be fetched.');
  }
}
