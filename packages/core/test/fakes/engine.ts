/**
 * A fake stremio-server-go (phase 2 step 8) for tests and the contract run.
 * It speaks the endpoints Multitap uses (okf:architecture/engine-endpoints-core-uses) with server-go's
 * shapes and status codes, never runs ffmpeg and never reaches the network:
 *
 * - `POST /{ih}/create`, `GET /{ih}/{idx}/stats.json` from {@link FakeTorrent}s;
 *   an unknown torrent times out like a metadata wait (`504`).
 * - `GET /hlsv2/probe` from probe fixtures (`sdr-1080p`, `hdr-4k`,
 *   `zero-duration`, `failing`, `multi-audio`) chosen per `mediaURL`.
 * - `GET /opensubHash?videoUrl=` answers `{ error, result: { hash, size } }` with
 *   a deterministic {@link fakeOpenSubHash} (`404` when `supportsOpenSubHash` is off;
 *   `500` for URLs set with `failOpenSubHashFor`).
 * - `GET /hlsv2/{sid}/master.m3u8` creates or reuses a session; master and
 *   media playlists use relative URIs like server-go's. Override parameters
 *   (`maxHeight`, `bitrate`, `ttl`, …) are recorded on every master request,
 *   honoured only when the `overrides` gate is on, and an out-of-range value
 *   gets `400`, like #25.
 * - `GET /hlsv2/{sid}/{file}` serves playlists and synthetic segment bytes
 *   after a configurable latency (with `playableMedia`, the committed real
 *   clip's bytes); a session that was evicted or forgotten in a restart answers
 *   `404` until its master is requested again.
 * - `DELETE /hlsv2/{sid}` like #24 (`204`/`404`/`400`), or the pre-#24 `404`
 *   for everything when `supportsDelete` is off.
 * - `GET /metrics`, `GET /yt/{id}` (a `307`), and `403` to any `Origin` header.
 * - `GET /proxy/stream` with `STREMIO_PROXY_PASSWORD` semantics when
 *   `proxyPassword` is set: `401` without the matching `api_password`. A probe
 *   or master request whose `mediaURL` is such an unauthorized engine-local
 *   proxy URL fails like ffprobe reading a `401` (`500`).
 *
 * Use it in-process through {@link FakeEngine.transport} (no sockets), or
 * over real HTTP with {@link FakeEngine.listen}.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import {
  EngineTransportError,
  type EngineRequestInit,
  type EngineTransport,
} from '../../src/engines/transport.ts';

export const FAKE_SELF_BASE = 'http://127.0.0.1:11470';
/** Segment length, seconds, as server-go's. */
export const FAKE_SEGMENT_SECONDS = 4;

export type ProbeFixtureName =
  | 'sdr-1080p'
  | 'hdr-4k'
  | 'zero-duration'
  | 'failing'
  | 'multi-audio'
  | 'multi-language'
  | 'playable'
  | 'playable-two-audio';

/** The committed, really playable test-pattern clip (`fixtures/playable-hls/`). */
export interface PlayableClip {
  /** Seconds per segment, in order. */
  durations: number[];
  /** `seg{i}.bin` (MPEG-TS) bytes, in order. */
  segments: Uint8Array<ArrayBuffer>[];
  /** The clip's total length, seconds. */
  duration: number;
}

const PLAYABLE_DIR = new URL('../fixtures/playable-hls/', import.meta.url);
let playableClip: PlayableClip | undefined;

/** Loads (once) the playable clip: the playlist's `EXTINF` durations and the segment files. */
export function loadPlayableClip(): PlayableClip {
  if (playableClip !== undefined) return playableClip;
  const text = readFileSync(fileURLToPath(new URL('playlist.m3u8', PLAYABLE_DIR)), 'utf8');
  const durations = [...text.matchAll(/^#EXTINF:([\d.]+),/gm)].map((m) => Number(m[1]));
  const segments = durations.map((_, i) => {
    const buf = readFileSync(fileURLToPath(new URL(`seg${String(i)}.bin`, PLAYABLE_DIR)));
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  });
  const duration = Math.round(durations.reduce((a, b) => a + b, 0) * 1000) / 1000;
  playableClip = { durations, segments, duration };
  return playableClip;
}

export interface FakeProbeStream {
  index: number;
  track: 'video' | 'audio' | 'subtitle';
  codec: string;
  width?: number;
  height?: number;
  lang?: string;
  default?: boolean;
  /** Audio only; default 2. */
  channels?: number;
  hdr?: string;
  profile?: string;
}

export interface FakeProbe {
  /** Seconds; 0 = live or unknown. */
  duration: number;
  formatName: string;
  streams: FakeProbeStream[];
  /** Answer `500` instead, like a failed ffprobe. */
  fail?: boolean;
}

export const PROBE_FIXTURES: Record<ProbeFixtureName, FakeProbe> = {
  'sdr-1080p': {
    duration: 120,
    formatName: 'matroska,webm',
    streams: [
      { index: 0, track: 'video', codec: 'h264', width: 1920, height: 1080, default: true },
      { index: 1, track: 'audio', codec: 'aac', lang: 'eng', default: true },
    ],
  },
  'hdr-4k': {
    duration: 120,
    formatName: 'matroska,webm',
    streams: [
      {
        index: 0,
        track: 'video',
        codec: 'hevc',
        width: 3840,
        height: 2160,
        default: true,
        profile: 'Main 10',
        hdr: 'hdr10',
      },
      { index: 1, track: 'audio', codec: 'eac3', lang: 'eng', default: true },
    ],
  },
  'zero-duration': {
    duration: 0,
    formatName: 'hls',
    streams: [{ index: 0, track: 'video', codec: 'h264', width: 1280, height: 720 }],
  },
  failing: { duration: 0, formatName: '', streams: [], fail: true },
  'multi-audio': {
    duration: 60,
    formatName: 'matroska,webm',
    streams: [
      { index: 0, track: 'video', codec: 'h264', width: 1280, height: 720, default: true },
      { index: 1, track: 'audio', codec: 'aac', lang: 'eng' },
      { index: 2, track: 'audio', codec: 'aac', lang: 'por', default: true },
      { index: 3, track: 'subtitle', codec: 'subrip', lang: 'eng' },
    ],
  },
  // An Italian release with an English dub marked default, 639-2/T tags, and
  // an image subtitle server-go leaves out of the master.
  // The committed test-pattern clip: what `playableMedia` serves (480x270, H.264 + AAC).
  playable: {
    duration: 120,
    formatName: 'mpegts',
    streams: [
      { index: 0, track: 'video', codec: 'h264', width: 480, height: 270, default: true },
      { index: 1, track: 'audio', codec: 'aac', lang: 'eng', default: true, channels: 1 },
    ],
  },
  // The playable clip as a two-language source: the clip muxes one audio track, so
  // the second rendition serves the same segments (the choice is what's tested).
  'playable-two-audio': {
    duration: 120,
    formatName: 'mpegts',
    streams: [
      { index: 0, track: 'video', codec: 'h264', width: 480, height: 270, default: true },
      { index: 1, track: 'audio', codec: 'aac', lang: 'eng', default: true, channels: 1 },
      { index: 2, track: 'audio', codec: 'aac', lang: 'ita', channels: 1 },
    ],
  },
  'multi-language': {
    duration: 60,
    formatName: 'matroska,webm',
    streams: [
      { index: 0, track: 'video', codec: 'h264', width: 1920, height: 1080, default: true },
      { index: 1, track: 'audio', codec: 'eac3', lang: 'eng', default: true, channels: 6 },
      { index: 2, track: 'audio', codec: 'ac3', lang: 'ita', channels: 6 },
      { index: 3, track: 'audio', codec: 'aac', lang: 'deu' },
      { index: 4, track: 'subtitle', codec: 'hdmv_pgs_subtitle', lang: 'ita', default: true },
      { index: 5, track: 'subtitle', codec: 'subrip', lang: 'ita' },
      { index: 6, track: 'subtitle', codec: 'ass', lang: 'eng' },
    ],
  },
};

/** Subtitle codecs server-go offers as WebVTT renditions; image subtitles are left out. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

export interface FakeTorrent {
  name?: string;
  files: { name: string; length: number }[];
  peers?: number;
  downloadSpeed?: number;
  /** Answer create with `504` (no metadata), as for a torrent without peers. */
  noMetadata?: boolean;
  /** Never answer create: wait until the request is aborted (a dead torrent within the metadata timeout). */
  stallMetadata?: boolean;
}

export interface FakeEngineOptions {
  /** `STREMIO_HLS_SESSION_OVERRIDES`: honour per-session overrides (default true). */
  overrides?: boolean;
  /** Has `DELETE /hlsv2/{id}` (#24; default true). */
  supportsDelete?: boolean;
  /** Has `GET /opensubHash` (default true). */
  supportsOpenSubHash?: boolean;
  /** Delay before a segment's bytes are sent, ms (default 0). */
  segmentLatencyMs?: number;
  /** Bytes per segment (default 1880, ten TS packets). */
  segmentBytes?: number;
  /** Probe fixture for a `mediaURL` without one set (default `sdr-1080p`; `playable` with `playableMedia`). */
  defaultProbe?: ProbeFixtureName;
  /**
   * Serve the committed test-pattern clip (`fixtures/playable-hls/`: real H.264 + AAC
   * MPEG-TS, 30 segments of 4 s) for every session instead of synthetic segment
   * bytes, so a browser really plays through Multitap's gateway (default false). Playlists
   * list the clip's real segments whatever the probe says; `segmentLatencyMs` and
   * {@link FakeEngine.segmentDelays} still apply.
   */
  playableMedia?: boolean;
  /**
   * With `playableMedia`: how many times the clip repeats (default 1). The playlist
   * lists its segments that many times, `#EXT-X-DISCONTINUITY` before each copy after
   * the first, segment `i` serves the clip's `i % segments`, and the default probe
   * reports `clip.duration * playableRepeat`.
   */
  playableRepeat?: number;
  /** Extra delay before named segments, ms: key `seg7.ts` (any session) or `{sid}/seg7.ts`. */
  segmentDelays?: Record<string, number>;
  torrents?: Record<string, FakeTorrent>;
  /** `STREMIO_PROXY_PASSWORD` (default none: `/proxy/stream` needs no password). */
  proxyPassword?: string;
}

/** The override parameters of one master request, as sent. */
export interface MasterOverrideParams {
  ttl?: string;
  maxWidth?: string;
  maxHeight?: string;
  bitrate?: string;
  maxRate?: string;
  bufSize?: string;
}

export interface MasterRecord {
  sid: string;
  mediaURL: string;
  overrides: MasterOverrideParams;
  /** This request created the session (the only time quality overrides apply). */
  created: boolean;
  status: number;
}

export interface FakeSession {
  sid: string;
  mediaURL: string;
  probe: FakeProbe;
  /** Overrides in effect (empty with the gate off). */
  applied: { maxHeight?: number; bitrate?: number; ttlSec?: number };
}

export interface FakeRequest {
  method: string;
  /** Path without the query. */
  path: string;
  query: Record<string, string>;
}

/** The hash and size the fake answers `/opensubHash` with for a `mediaURL`: derived from it, stable. */
export function fakeOpenSubHash(mediaURL: string): { hash: string; size: number } {
  const digest = createHash('sha256').update(mediaURL).digest();
  return {
    hash: digest.subarray(0, 8).toString('hex'),
    size: 700_000_000 + (digest.readUInt32BE(8) % 1_000_000),
  };
}

const OVERRIDE_PARAMS = ['ttl', 'maxWidth', 'maxHeight', 'bitrate', 'maxRate', 'bufSize'] as const;

/**
 * server-go's `compileMustInclude`: `/body/flags` is a regex (flag `i` honoured),
 * anything else a literal substring.
 */
function compileMustInclude(value: string): RegExp | undefined {
  if (value === '') return undefined;
  if (value.length > 1 && value.startsWith('/')) {
    const end = value.lastIndexOf('/');
    if (end > 0) {
      try {
        return new RegExp(value.slice(1, end), value.slice(end + 1).includes('i') ? 'i' : '');
      } catch {
        // Not a valid regex: a literal, as in server-go.
      }
    }
  }
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** server-go's `parseDecimalBitrate`: a number with an optional k/M/G suffix. */
function parseBitrate(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/.exec(raw.trim());
  if (m === null) return undefined;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** server-go's `parseSecondsOrDuration` for the subset Multitap sends (whole seconds, or `90m`-style). */
function parseTtlSeconds(raw: string): number | undefined {
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(\d+)(s|m|h)$/.exec(v);
  if (m === null) return undefined;
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'];
}

/** #25's validation; returns the parsed values or an error message (→ 400). */
function parseOverrides(
  params: MasterOverrideParams,
): { ok: true; applied: FakeSession['applied'] } | { ok: false; error: string } {
  const applied: FakeSession['applied'] = {};
  for (const name of ['maxWidth', 'maxHeight'] as const) {
    const raw = params[name];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 16 || n > 7680)
      return { ok: false, error: `${name} out of range` };
    if (name === 'maxHeight') applied.maxHeight = n - (n % 2);
  }
  for (const name of ['bitrate', 'maxRate', 'bufSize'] as const) {
    const raw = params[name];
    if (raw === undefined || raw.trim() === '') continue;
    const n = parseBitrate(raw);
    const max = name === 'bufSize' ? 400e6 : 200e6;
    if (n === undefined || n < 100e3 || n > max)
      return { ok: false, error: `${name} out of range` };
    if (name === 'bitrate') applied.bitrate = n;
  }
  if (params.ttl !== undefined && params.ttl.trim() !== '') {
    const s = parseTtlSeconds(params.ttl);
    if (s === undefined || s < 60 || s > 30 * 86400)
      return { ok: false, error: 'ttl out of range' };
    applied.ttlSec = s;
  }
  return { ok: true, applied };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

export class FakeEngine {
  readonly options: Required<
    Omit<FakeEngineOptions, 'torrents' | 'proxyPassword' | 'segmentDelays'>
  > & {
    proxyPassword: string | undefined;
  };
  readonly torrents = new Map<string, FakeTorrent>();
  /**
   * Extra delay, ms, added to `segmentLatencyMs` for named segments: key `seg7.ts` (any
   * session) or `{sid}/seg7.ts` (that session, which wins). Changeable at runtime.
   */
  readonly segmentDelays = new Map<string, number>();
  /** Sessions the engine currently holds. */
  readonly sessions = new Map<string, FakeSession>();
  /** Every request, in order. */
  readonly requests: FakeRequest[] = [];
  /** Every master request, with its override parameters. */
  readonly masterRequests: MasterRecord[] = [];
  /** Engine-side request count per `{sid}/{file}` (gateway dedupe tests). */
  readonly fileRequests = new Map<string, number>();
  /** Segments fully sent, and ones whose requester went away mid-latency, as `{sid}/{file}`. */
  readonly segmentsCompleted: string[] = [];
  readonly segmentsAborted: string[] = [];
  /** Torrent creates, with their bodies. */
  readonly creates: { infoHash: string; body: Record<string, unknown> }[] = [];
  readonly deletes: string[] = [];
  /** `/opensubHash` requests, as the `videoUrl`s received. */
  readonly openSubHashRequests: string[] = [];
  /** `videoUrl`s `/opensubHash` fails for (`500`). */
  readonly failOpenSubHashFor = new Set<string>();
  /** Delay before `/opensubHash` answers, ms (a slow read of the file's ends). */
  openSubHashLatencyMs = 0;
  /** Creates whose requester went away while the metadata wait stalled. */
  readonly createsAborted: string[] = [];
  /** While set, master requests wait for it before answering (a slow session create). */
  masterHold: Promise<void> | undefined;
  /** Segment requests (`{sid}/{file}`) to answer once with `404`, as a source failing mid-stream does. */
  readonly failSegmentOnce = new Set<string>();
  /** Segment requests (`{sid}/{file}`) to answer once with the given status, as an engine with #53 does for a failed source (`502`) or a transcode past its deadline (`504`). */
  readonly failSegmentOnceWith = new Map<string, 502 | 504>();
  /** Torrent creates still to refuse with `503` + `Retry-After: 5`, as at the engine's `STREMIO_MAX_ENGINES` cap. */
  busyCreates = 0;
  /** `/proxy/stream` reads refused for a missing or wrong `api_password` (direct or via probe/master). */
  readonly proxyRefusals: string[] = [];
  /** Engine restarts so far. */
  restarts = 0;
  /** While false, the in-process transport fails like an unreachable host and `/metrics` is not served. */
  online = true;

  readonly #probes = new Map<string, FakeProbe>();
  readonly #torrentsAdded = new Set<string>();
  readonly app: Hono;
  #server: ServerType | undefined;

  constructor(options: FakeEngineOptions = {}) {
    this.options = {
      overrides: options.overrides ?? true,
      supportsDelete: options.supportsDelete ?? true,
      supportsOpenSubHash: options.supportsOpenSubHash ?? true,
      segmentLatencyMs: options.segmentLatencyMs ?? 0,
      segmentBytes: options.segmentBytes ?? 1880,
      defaultProbe:
        options.defaultProbe ?? (options.playableMedia === true ? 'playable' : 'sdr-1080p'),
      playableMedia: options.playableMedia ?? false,
      playableRepeat: Math.max(1, Math.floor(options.playableRepeat ?? 1)),
      proxyPassword: options.proxyPassword,
    };
    for (const [file, ms] of Object.entries(options.segmentDelays ?? {}))
      this.segmentDelays.set(file, ms);
    for (const [ih, t] of Object.entries(options.torrents ?? {}))
      this.torrents.set(ih.toLowerCase(), t);
    this.app = this.#buildApp();
  }

  // ---- Test controls -----------------------------------------------------------------

  /** Sets the probe fixture for a `mediaURL` (exact match). */
  setProbe(mediaURL: string, probe: ProbeFixtureName | FakeProbe): void {
    this.#probes.set(mediaURL, typeof probe === 'string' ? PROBE_FIXTURES[probe] : probe);
  }

  addTorrent(infoHash: string, torrent: FakeTorrent): void {
    this.torrents.set(infoHash.toLowerCase(), torrent);
  }

  /** Evicts one session (idle TTL): its files `404` until the master is requested again. */
  evict(sid: string): void {
    this.sessions.delete(sid);
  }

  /** A restart: every session and active torrent is forgotten (no persistence). */
  restart(): void {
    this.sessions.clear();
    this.#torrentsAdded.clear();
    this.restarts += 1;
  }

  /** Master requests for one session. */
  mastersFor(sid: string): MasterRecord[] {
    return this.masterRequests.filter((m) => m.sid === sid);
  }

  fileRequestCount(sid: string, file: string): number {
    return this.fileRequests.get(`${sid}/${file}`) ?? 0;
  }

  /**
   * False when `mediaURL` is this engine's own `/proxy/stream` URL and the
   * engine has a proxy password it doesn't carry (server-go's `api_password`
   * check). Other URLs are always allowed.
   */
  proxyAllowed(mediaURL: string): boolean {
    let url: URL;
    try {
      url = new URL(mediaURL);
    } catch {
      return true;
    }
    if (url.origin !== FAKE_SELF_BASE || url.pathname !== '/proxy/stream') return true;
    const password = this.options.proxyPassword;
    if (password === undefined || password === '') return true;
    if (url.searchParams.get('api_password') === password) return true;
    this.proxyRefusals.push(url.pathname);
    return false;
  }

  /** The probe for a `mediaURL`. */
  probeFor(mediaURL: string): FakeProbe {
    const set = this.#probes.get(mediaURL);
    if (set !== undefined) return set;
    const probe = PROBE_FIXTURES[this.options.defaultProbe];
    if (this.options.playableMedia && this.options.playableRepeat > 1) {
      return { ...probe, duration: loadPlayableClip().duration * this.options.playableRepeat };
    }
    return probe;
  }

  /** An in-process transport (no sockets) honouring the transport contract. */
  transport(engineId = 'fake'): EngineTransport {
    return {
      kind: 'lan',
      request: async (path: string, init: EngineRequestInit) => {
        if (!this.online) throw new EngineTransportError(engineId, 'network', 'engine unreachable');
        if (init.signal?.aborted === true) {
          throw new EngineTransportError(engineId, 'aborted', 'engine request aborted');
        }
        const req = new Request(`http://fake-engine${path}`, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new EngineTransportError(engineId, 'timeout', 'engine did not answer'));
          }, init.timeoutMs);
          timer.unref();
        });
        try {
          return await Promise.race([Promise.resolve(this.app.fetch(req)), timeout]);
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  /** Serves over real HTTP on 127.0.0.1 (port 0 = any); returns the base address. */
  async listen(port = 0): Promise<string> {
    const server = serve({ fetch: this.app.fetch, port, hostname: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    this.#server = server;
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
  }

  // ---- The engine -----------------------------------------------------------------------

  #segmentCount(session: FakeSession): number {
    if (this.options.playableMedia) {
      return loadPlayableClip().segments.length * this.options.playableRepeat;
    }
    return Math.max(1, Math.ceil(session.probe.duration / FAKE_SEGMENT_SECONDS));
  }

  #audioTracks(session: FakeSession): FakeProbeStream[] {
    return session.probe.streams.filter((s) => s.track === 'audio');
  }

  #master(session: FakeSession): string {
    const audio = this.#audioTracks(session);
    const subs = session.probe.streams.filter(
      (s) => s.track === 'subtitle' && TEXT_SUBTITLES.has(s.codec),
    );
    const height = Math.min(
      session.probe.streams.find((s) => s.track === 'video')?.height ?? 720,
      session.applied.maxHeight ?? Number.POSITIVE_INFINITY,
    );
    const bandwidth = session.applied.bitrate ?? 8_000_000;
    const inf = `BANDWIDTH=${String(bandwidth)},CODECS="avc1.640028,mp4a.40.2",RESOLUTION=x${String(height)}`;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:4'];
    subs.forEach((s, k) => {
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${s.lang ?? 'und'}",NAME="${s.lang ?? 'und'}",DEFAULT=${k === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI="sub${String(k)}.m3u8"`,
      );
    });
    const subsAttr = subs.length > 0 ? ',SUBTITLES="subs"' : '';
    if (audio.length < 2) {
      lines.push(`#EXT-X-STREAM-INF:${inf}${subsAttr}`, 'playlist.m3u8');
    } else {
      const def = Math.max(
        0,
        audio.findIndex((a) => a.default === true),
      );
      audio.forEach((a, k) => {
        const yes = k === def ? 'YES' : 'NO';
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="${a.lang ?? 'und'}",NAME="${a.lang ?? `Audio ${String(k + 1)}`}",DEFAULT=${yes},AUTOSELECT=${yes},URI="audio${String(k)}.m3u8"`,
        );
      });
      lines.push(`#EXT-X-STREAM-INF:${inf},AUDIO="aud"${subsAttr}`, 'video.m3u8');
    }
    return `${lines.join('\n')}\n`;
  }

  #mediaPlaylist(session: FakeSession, prefix: string): string {
    const n = this.#segmentCount(session);
    const clip = this.options.playableMedia ? loadPlayableClip() : undefined;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      `#EXT-X-TARGETDURATION:${String(FAKE_SEGMENT_SECONDS)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    for (let i = 0; i < n; i += 1) {
      const d =
        clip?.durations[i % clip.durations.length] ??
        Math.min(FAKE_SEGMENT_SECONDS, session.probe.duration - i * FAKE_SEGMENT_SECONDS);
      if (clip !== undefined && i > 0 && i % clip.segments.length === 0) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      lines.push(`#EXTINF:${Math.max(d, 0.001).toFixed(3)},`, `${prefix}seg${String(i)}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
  }

  /** Deterministic bytes: TS sync bytes, then the file name, so tests can tell segments apart. */
  segmentBody(sid: string, file: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(this.options.segmentBytes);
    for (let i = 0; i < bytes.length; i += 188) bytes[i] = 0x47;
    const tag = new TextEncoder().encode(`${sid}/${file}`);
    bytes.set(tag.subarray(0, Math.max(0, Math.min(tag.length, bytes.length - 1))), 1);
    return bytes;
  }

  #buildApp(): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
      const url = new URL(c.req.url);
      this.requests.push({
        method: c.req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });
      // server-go's Origin allowlist (okf:architecture/engine-security-posture): Multitap never sends one.
      if (c.req.header('origin') !== undefined) {
        return c.json({ error: 'origin not allowed' }, 403);
      }
      await next();
    });

    app.get('/metrics', (c) =>
      c.text(
        `# HELP stremio_hls_sessions Active HLS sessions\n# TYPE stremio_hls_sessions gauge\nstremio_hls_sessions ${String(this.sessions.size)}\n`,
        200,
        { 'Content-Type': 'text/plain; version=0.0.4' },
      ),
    );

    app.get('/yt/:id', (c) => c.redirect(`https://video.invalid/${c.req.param('id')}`, 307));

    app.get('/proxy/stream', (c) => {
      const password = this.options.proxyPassword;
      if (password !== undefined && password !== '' && c.req.query('api_password') !== password) {
        this.proxyRefusals.push('/proxy/stream');
        return c.text('unauthorized', 401);
      }
      return c.body(this.segmentBody('proxy', 'stream'), 200, {
        'Content-Type': 'video/x-matroska',
      });
    });

    app.get('/hlsv2/probe', (c) => {
      const mediaURL = c.req.query('mediaURL') ?? '';
      if (!this.proxyAllowed(mediaURL)) {
        return c.text('ffprobe: Server returned 401 Unauthorized', 500);
      }
      const probe = this.probeFor(mediaURL);
      if (probe.fail === true) return c.text('ffprobe: exit status 1', 500);
      return c.json({
        format: { name: probe.formatName },
        duration: probe.duration,
        streams: probe.streams.map((s) => ({
          index: s.index,
          track: s.track,
          codec: s.codec,
          channels: s.track === 'audio' ? (s.channels ?? 2) : 0,
          width: s.width ?? 0,
          height: s.height ?? 0,
          fps: s.track === 'video' ? 24 : 0,
          bitrate: 0,
          lang: s.lang ?? '',
          default: s.default ?? false,
          profile: s.profile ?? '',
          ...(s.hdr !== undefined ? { hdr: s.hdr } : {}),
        })),
      });
    });

    app.get('/opensubHash', async (c) => {
      if (!this.options.supportsOpenSubHash) return c.text('404 page not found', 404);
      const videoUrl = c.req.query('videoUrl') ?? '';
      this.openSubHashRequests.push(videoUrl);
      if (this.openSubHashLatencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.openSubHashLatencyMs));
      }
      if (!this.proxyAllowed(videoUrl) || this.failOpenSubHashFor.has(videoUrl)) {
        return c.json({ error: 'opensub: Get "<url>": status 401', result: null }, 500);
      }
      return c.json({ error: null, result: fakeOpenSubHash(videoUrl) });
    });

    app.delete('/hlsv2/:sid', (c) => {
      if (!this.options.supportsDelete) return c.text('404 page not found', 404);
      const sid = c.req.param('sid');
      if (sid === '' || sid === '.' || sid.includes('..') || sid.includes('/')) {
        return c.text(`hls: invalid session id "${sid}"`, 400);
      }
      if (!this.sessions.delete(sid)) return c.text(`hls: session not found ${sid}`, 404);
      this.deletes.push(sid);
      return c.body(null, 204);
    });

    app.get('/hlsv2/:sid/master.m3u8', async (c) => {
      if (this.masterHold !== undefined) await this.masterHold;
      const sid = c.req.param('sid');
      const mediaURL = c.req.query('mediaURL') ?? '';
      const params: MasterOverrideParams = {};
      for (const name of OVERRIDE_PARAMS) {
        const value = c.req.query(name);
        if (value !== undefined) params[name] = value;
      }
      const record: MasterRecord = {
        sid,
        mediaURL,
        overrides: params,
        created: false,
        status: 200,
      };
      this.masterRequests.push(record);
      const answer = (status: 400 | 500, text: string) => {
        record.status = status;
        return c.text(text, status);
      };
      if (mediaURL === '') return answer(500, 'hls: missing mediaURL');
      if (!/^https?:\/\//.test(mediaURL)) return answer(500, 'hls: forbidden target');
      if (!this.proxyAllowed(mediaURL)) {
        return answer(500, 'hls: probe: Server returned 401 Unauthorized');
      }
      let applied: FakeSession['applied'] = {};
      if (this.options.overrides) {
        const parsed = parseOverrides(params);
        if (!parsed.ok) return answer(400, `hls: invalid per-session option: ${parsed.error}`);
        applied = parsed.applied;
      }
      let session = this.sessions.get(sid);
      if (session === undefined) {
        session = { sid, mediaURL, probe: this.probeFor(mediaURL), applied };
        this.sessions.set(sid, session);
        record.created = true;
      } else if (applied.ttlSec !== undefined) {
        // Existing session: only the TTL may change.
        session.applied = { ...session.applied, ttlSec: applied.ttlSec };
      }
      return c.text(this.#master(session), 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      });
    });

    app.get('/hlsv2/:sid/:file', async (c) => {
      const sid = c.req.param('sid');
      const file = c.req.param('file');
      const key = `${sid}/${file}`;
      this.fileRequests.set(key, (this.fileRequests.get(key) ?? 0) + 1);
      const session = this.sessions.get(sid);
      if (session === undefined) return c.text(`hls: session not found ${sid}`, 404);
      const playlist = {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      };
      const audio = this.#audioTracks(session);
      const multi = audio.length >= 2;
      if (file === 'playlist.m3u8' && !multi)
        return c.text(this.#mediaPlaylist(session, ''), 200, playlist);
      if (file === 'video.m3u8' && multi)
        return c.text(this.#mediaPlaylist(session, ''), 200, playlist);
      const audioPl = /^audio(\d+)\.m3u8$/.exec(file);
      if (audioPl !== null && multi && Number(audioPl[1]) < audio.length) {
        return c.text(this.#mediaPlaylist(session, `a${audioPl[1] ?? ''}`), 200, playlist);
      }
      const subPl = /^sub(\d+)\.(m3u8|vtt)$/.exec(file);
      if (subPl !== null) {
        if (subPl[2] === 'm3u8') {
          return c.text(
            `#EXTM3U\n#EXT-X-TARGETDURATION:${String(Math.ceil(session.probe.duration))}\n#EXTINF:${session.probe.duration.toFixed(3)},\nsub${subPl[1] ?? ''}.vtt\n#EXT-X-ENDLIST\n`,
            200,
            playlist,
          );
        }
        return c.text('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', 200, {
          'Content-Type': 'text/vtt',
        });
      }
      const seg = /^(?:a(\d+))?seg(\d+)\.ts$/.exec(file);
      if (seg !== null) {
        const n = Number(seg[2]);
        if (n >= this.#segmentCount(session)) return c.text('hls: segment out of range', 404);
        if (this.failSegmentOnce.delete(key)) return c.text('hls: segment failed', 404);
        const failWith = this.failSegmentOnceWith.get(key);
        if (failWith !== undefined) {
          this.failSegmentOnceWith.delete(key);
          return c.text('hls: source failed', failWith);
        }
        if (seg[1] !== undefined && (!multi || Number(seg[1]) >= audio.length)) {
          return c.text('hls: no such audio stream', 404);
        }
        try {
          const extra = this.segmentDelays.get(key) ?? this.segmentDelays.get(file) ?? 0;
          await sleep(this.options.segmentLatencyMs + extra, c.req.raw.signal);
        } catch {
          this.segmentsAborted.push(key);
          // Nobody reads this; server-go would have killed the ffmpeg run.
          return c.body(null, 500);
        }
        // An eviction or restart during the transcode loses the segment.
        if (!this.sessions.has(sid)) return c.text(`hls: session not found ${sid}`, 404);
        this.segmentsCompleted.push(key);
        // The clip has one audio rendition muxed in: `a{k}seg{n}.ts` is the same segment.
        const real = this.options.playableMedia
          ? loadPlayableClip().segments[n % loadPlayableClip().segments.length]
          : undefined;
        return c.body(real ?? this.segmentBody(sid, file), 200, {
          'Content-Type': 'video/mp2t',
          'Cache-Control': 'no-cache',
        });
      }
      return c.text('hls: unknown file', 404);
    });

    app.post('/:ih/create', async (c) => {
      const ih = c.req.param('ih').toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(ih)) return c.text('404 page not found', 404);
      let body: Record<string, unknown> = {};
      try {
        body = await c.req.json();
      } catch {
        // Empty or invalid bodies are accepted, as by server-go.
      }
      this.creates.push({ infoHash: ih, body });
      if (this.busyCreates > 0) {
        this.busyCreates -= 1;
        c.header('Retry-After', '5');
        return c.text('engine: too many active torrents', 503);
      }
      const torrent = this.torrents.get(ih);
      if (torrent?.stallMetadata === true) {
        const signal = c.req.raw.signal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener('abort', () => {
            resolve();
          });
        });
        this.createsAborted.push(ih);
        return c.text('context canceled', 500);
      }
      if (torrent === undefined || torrent.noMetadata === true) {
        return c.text('context deadline exceeded', 504);
      }
      this.#torrentsAdded.add(ih);
      const stats: Record<string, unknown> = this.#stats(ih, torrent);
      const files = torrent.files;
      const mustInclude = Array.isArray(body.fileMustInclude)
        ? (body.fileMustInclude as string[])
        : [];
      let guessed: number | undefined;
      for (const pattern of mustInclude) {
        const re = compileMustInclude(pattern);
        if (re === undefined) continue;
        files.forEach((f, i) => {
          if (re.test(f.name)) guessed = i;
        });
      }
      if (guessed === undefined && body.guessFileIdx === true && files.length > 0) {
        // server-go guesses the largest file.
        guessed = files.reduce(
          (best, f, i) => (f.length > (files[best]?.length ?? -1) ? i : best),
          0,
        );
      }
      if (guessed !== undefined) stats.guessedFileIdx = guessed;
      return c.json(stats);
    });

    app.get('/:ih/:idx/stats.json', (c) => {
      const ih = c.req.param('ih').toLowerCase();
      const torrent = this.torrents.get(ih);
      if (torrent === undefined || !this.#torrentsAdded.has(ih)) return c.json(null);
      const idx = Number(c.req.param('idx'));
      const file = torrent.files[idx];
      return c.json({
        ...this.#stats(ih, torrent),
        ...(file === undefined
          ? {}
          : { streamLen: file.length, streamName: file.name, streamProgress: 0.25 }),
      });
    });

    app.notFound((c) => c.text('404 page not found', 404));
    return app;
  }

  #stats(ih: string, torrent: FakeTorrent): Record<string, unknown> {
    return {
      infoHash: ih,
      name: torrent.name ?? 'Fake torrent',
      peers: torrent.peers ?? 12,
      unchoked: 0,
      queued: 0,
      unique: 0,
      connectionTries: 0,
      swarmPaused: false,
      swarmConnections: 0,
      swarmSize: 0,
      selections: null,
      wires: null,
      files: torrent.files.map((f, i) => ({
        name: f.name,
        path: f.name,
        length: f.length,
        offset: i,
      })),
      downloaded: 0,
      uploaded: 0,
      downloadSpeed: torrent.downloadSpeed ?? 1_000_000,
      uploadSpeed: 0,
      sources: [],
      opts: {},
      peerSearchRunning: false,
    };
  }
}
