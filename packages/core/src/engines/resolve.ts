/**
 * The resolution matrix's pure half (okf:architecture/engine-prepare-stream): classifies a raw
 * addon `Stream` into what the engine module must do to get a `mediaURL`.
 * The engine calls (torrent create, probe) happen in engine-module.ts.
 */
import { createHash } from 'node:crypto';
import type { SessionQuality } from '@multitap/api';
import { StreamSchema, streamSourceVariant, type Stream } from '@multitap/addon-protocol';

export type StreamPlan =
  | {
      kind: 'torrent';
      infoHash: string;
      /** Absent: the engine guesses it (`guessFileIdx` / `fileMustInclude`). */
      fileIdx?: number;
      /** `peerSearch.sources`: `tracker:…` and `dht:…` entries. */
      sources: string[];
      fileMustInclude: string[];
    }
  /** A direct URL; `hls` when it looks like a playlist (live vs VOD is decided by the probe). */
  | { kind: 'url'; url: string; hls: boolean }
  /** A URL that needs `behaviorHints.proxyHeaders`: wrapped in the engine's `/proxy/stream`. */
  | {
      kind: 'proxy';
      url: string;
      hls: boolean;
      requestHeaders: Record<string, string>;
      responseHeaders: Record<string, string>;
    }
  | { kind: 'youtube'; ytId: string }
  | { kind: 'unplayable'; reason: 'unsupported' | 'external' };

function isHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function looksLikePlaylist(url: URL): boolean {
  return /\.m3u8?$/i.test(url.pathname);
}

/** Addons give `tracker:…`/`dht:…`; a bare announce URL gets the `tracker:` prefix server-go reads. */
export function normalizeSources(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const source =
      /^(tracker|dht):/i.test(trimmed) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `tracker:${trimmed}`;
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

/** The tracker URLs among normalized sources (`tracker:…`; `dht:…` entries are not trackers). */
export function trackersOf(sources: readonly string[]): string[] {
  return sources.filter((s) => /^tracker:/i.test(s)).map((s) => s.slice('tracker:'.length));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classifies a stream, raw or parsed, using stremio-core's source precedence. */
export function planStream(stream: Stream | Record<string, unknown>): StreamPlan {
  const parsed = StreamSchema.safeParse(stream);
  if (!parsed.success) return { kind: 'unplayable', reason: 'unsupported' };
  const s = parsed.data;
  const variant = streamSourceVariant(s);
  switch (variant) {
    case 'url': {
      const url = isHttpUrl(s.url as string);
      if (url === undefined) return { kind: 'unplayable', reason: 'unsupported' };
      const proxy = s.behaviorHints.proxyHeaders;
      const requestHeaders = proxy?.request ?? {};
      const responseHeaders = proxy?.response ?? {};
      if (Object.keys(requestHeaders).length > 0 || Object.keys(responseHeaders).length > 0) {
        return {
          kind: 'proxy',
          url: url.href,
          hls: looksLikePlaylist(url),
          requestHeaders,
          responseHeaders,
        };
      }
      return { kind: 'url', url: s.url as string, hls: looksLikePlaylist(url) };
    }
    case 'youTube': {
      const ytId = (s.ytId as string).trim();
      return ytId === ''
        ? { kind: 'unplayable', reason: 'unsupported' }
        : { kind: 'youtube', ytId };
    }
    case 'torrent': {
      const fileIdx = typeof s.fileIdx === 'number' ? s.fileIdx : undefined;
      const announce = Array.isArray(s.announce) ? (s.announce as string[]) : [];
      const mustInclude = Array.isArray(s.fileMustInclude) ? (s.fileMustInclude as string[]) : [];
      const filename = s.behaviorHints.filename;
      const fileMustInclude =
        fileIdx !== undefined
          ? []
          : mustInclude.length > 0
            ? mustInclude
            : filename !== undefined && filename !== ''
              ? // server-go matches the torrent-relative path (`Folder/Name.mkv`), and
                // reads an entry as a regex only in `/…/flags` form (else a literal substring).
                [`/(?:^|/)${escapeRegex(filename)}$/`]
              : [];
      const plan: StreamPlan = {
        kind: 'torrent',
        infoHash: (s.infoHash as string).toLowerCase(),
        sources: normalizeSources(announce),
        fileMustInclude,
      };
      if (fileIdx !== undefined) plan.fileIdx = fileIdx;
      return plan;
    }
    case 'external':
      return { kind: 'unplayable', reason: 'external' };
    default:
      // Archives, NZB, player frames: not handled by the engine module (yet).
      return { kind: 'unplayable', reason: 'unsupported' };
  }
}

/** JSON with sorted keys, so equal objects hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // `undefined` (never in parsed JSON) would stringify to undefined.
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** `hash(stream)` in the engine session lookup (okf:architecture/engine-prepare-stream): SHA-256 hex of the canonical raw stream. */
export function streamHash(stream: unknown): string {
  return createHash('sha256').update(canonicalJson(stream)).digest('hex');
}

/** The overrides actually sent, without empty fields; undefined when there are none. */
export function normalizeQuality(quality: SessionQuality | undefined): SessionQuality | undefined {
  if (quality === undefined) return undefined;
  const out: SessionQuality = {};
  if (quality.maxHeight !== undefined) out.maxHeight = quality.maxHeight;
  if (quality.bitrate !== undefined) out.bitrate = quality.bitrate;
  return out.maxHeight === undefined && out.bitrate === undefined ? undefined : out;
}

/** `engine_sessions.quality_key`: '' for none, so two qualities never share an engine session (okf:architecture/rendition-and-bandwidth). */
export function qualityKey(applied: SessionQuality | undefined): string {
  if (applied === undefined) return '';
  return `h=${applied.maxHeight === undefined ? '' : String(applied.maxHeight)};b=${
    applied.bitrate === undefined ? '' : String(applied.bitrate)
  }`;
}
