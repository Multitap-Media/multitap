/**
 * The typed stremio-server-go client's contract (okf:architecture/engine-endpoints-core-uses, okf:architecture/engine-transport-and-health):
 * the endpoints phase 2 uses, over an {@link EngineTransport}. Types only;
 * phase 2 step 2 implements {@link ServerGoClient} (engines/server-go.ts).
 *
 * The client parses engine JSON into these shapes and nothing else: callers
 * never see raw engine responses. `mediaURL`s are secrets (okf:architecture/secrets-policy).
 */
import type { EngineTransport } from './transport.ts';

/** `POST /{infoHash}/create` body (server-go's `createBody`). */
export interface TorrentCreateRequest {
  /** `peerSearch.sources` from the addon's `Stream.sources` (trackers, `dht:…`). */
  sources?: string[];
  /** Regexes; the last file whose name matches becomes `guessedFileIdx`. */
  fileMustInclude?: string[];
  /** Ask the engine to guess the main file when no `fileIdx` is known. */
  guessFileIdx?: boolean;
  /** Aborts the metadata wait (a release, or auto-select's attempt timeout). */
  signal?: AbortSignal;
}

export interface TorrentFile {
  name: string;
  length: number;
}

/** The parts of server-go's `types.Stats` Multitap uses. */
export interface TorrentStats {
  infoHash: string;
  name: string;
  peers: number;
  downloadSpeed: number;
  files: TorrentFile[];
  /** From `create` with `guessFileIdx` or `fileMustInclude`. */
  guessedFileIdx?: number;
  /** Per-file extras, from `/{ih}/{idx}/stats.json`. */
  streamLen?: number;
  streamProgress?: number;
}

export interface ProbeStream {
  index: number;
  /** `video`, `audio` or `subtitle`, as the engine reports it. */
  track: string;
  codec: string;
  width?: number;
  height?: number;
  lang?: string;
  default?: boolean;
  /** Audio only. */
  channels?: number;
  /** Video: `hdr10`, `dv`, … when the engine reports it. */
  hdr?: string;
  profile?: string;
  bitDepth?: number;
}

/** `/hlsv2/probe?mediaURL=` reshaped (server-go's `reshapeProbeResult`). */
export interface ProbeResult {
  /** Seconds; 0 for live or unknown (→ unplayable for VOD, okf:architecture/engine-prepare-stream). */
  durationSec: number;
  formatName?: string;
  streams: ProbeStream[];
}

/** Per-session overrides on the creating master request (#25, okf:architecture/rendition-and-bandwidth). */
export interface MasterOverrides {
  maxHeight?: number;
  /** Bits per second; sent in ffmpeg syntax. */
  bitrate?: number;
  /** Per-session idle TTL, seconds (#25): a safety net only (okf:architecture/engine-retention). */
  ttlSec?: number;
}

export interface MasterRequest {
  sid: string;
  /** Secret. */
  mediaURL: string;
  /** Only on an engine with `sessionOverrides`; the engine answers `400` to an out-of-range value. */
  overrides?: MasterOverrides;
  /** Defaults to the client's `prepare` timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type DeleteSessionResult = 'deleted' | 'not-found' | 'unsupported';

/** `/proxy/stream` URL parts (okf:architecture/engine-prepare-stream matrix: `url` + `behaviorHints.proxyHeaders`). */
export interface ProxyStreamRequest {
  /** Secret. */
  url: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** `STREMIO_PROXY_PASSWORD`, when the engine sets one. */
  apiPassword?: string;
}

export interface ServerGoClient {
  readonly engineId: string;
  readonly transport: EngineTransport;

  /** `POST /{infoHash}/create`: add the torrent, wait for metadata, resolve the file. */
  createTorrent(infoHash: string, request: TorrentCreateRequest): Promise<TorrentStats>;
  /** `GET /{infoHash}/{fileIdx}/stats.json`. Undefined when the engine has no such torrent (it answers `null`). */
  torrentStats(infoHash: string, fileIdx: number): Promise<TorrentStats | undefined>;
  /** `GET /hlsv2/probe?mediaURL=`. Rejects with the engine's status on failure. */
  probe(mediaURL: string, signal?: AbortSignal): Promise<ProbeResult>;
  /**
   * `GET /hlsv2/{sid}/master.m3u8?mediaURL=…[&maxHeight&bitrate&ttl]`:
   * creates or reuses the session (self-heal, okf:architecture/engine-session-lifecycle). Returns the raw response
   * for the gateway to stream.
   */
  master(request: MasterRequest): Promise<Response>;
  /** `GET /hlsv2/{sid}/{file}`: media playlists, segments, VTT. Raw response. */
  file(sid: string, file: string, signal?: AbortSignal): Promise<Response>;
  /** `DELETE /hlsv2/{sid}` (#24). `unsupported` on an engine without it. */
  deleteSession(sid: string): Promise<DeleteSessionResult>;
  /** Whether the engine has `DELETE /hlsv2/{id}` (probed once, then cached). */
  supportsDelete(): Promise<boolean>;
  /** Forgets cached capabilities (the health check calls it when an engine comes back online). */
  resetCapabilities(): void;
  /** The engine's own loopback origin, `http://127.0.0.1:{port}`, which its SSRF guard allows. */
  readonly selfBase: string;
  /**
   * The engine-local `mediaURL` for a torrent file: `http://127.0.0.1:11470/{ih}/{idx}`,
   * with a `tr` parameter per tracker so the engine re-adds the torrent with them
   * whenever it opens it again (after a restart, or once its idle timeout dropped it).
   */
  torrentMediaURL(infoHash: string, fileIdx: number, trackers?: readonly string[]): string;
  /** The engine-local `mediaURL` for a YouTube id: `http://127.0.0.1:11470/yt/{id}`. */
  youtubeMediaURL(ytId: string): string;
  /** The engine-local `/proxy/stream?d=…&h_…=…[&api_password=…]` `mediaURL`. */
  proxyStreamMediaURL(request: ProxyStreamRequest): string;
  /**
   * `mediaURL` with `api_password` added when it is one of this engine's own
   * `/proxy/stream` URLs (and a password is given); any other URL unchanged.
   * The engine module stores `mediaURL`s without the password and adds it here,
   * right before sending, so a changed password applies to existing sessions.
   */
  withApiPassword(mediaURL: string, apiPassword: string | undefined): string;
  /** `GET /metrics` (Prometheus text), for health. */
  metrics(): Promise<string>;
  /**
   * `GET /opensubHash?videoUrl=`: the OpenSubtitles hash and size of the file,
   * which the engine reads from its start and end. Undefined on an engine that
   * lacks the endpoint (remembered until {@link resetCapabilities}). Rejects
   * with a {@link ServerGoError} on any other failure.
   */
  openSubHash(mediaURL: string, signal?: AbortSignal): Promise<OpenSubHash | undefined>;
}

/** The engine's answer to `/opensubHash`. */
export interface OpenSubHash {
  /** 16 lower-case hex digits. */
  hash: string;
  /** Bytes. */
  size: number;
}

/** An engine answered with an unexpected status or body. Never carries the URL. */
export class ServerGoError extends Error {
  override name = 'ServerGoError';
  readonly status: number | undefined;
  readonly endpoint: string;
  /** The engine's error text, already scrubbed of URLs and secrets and cut to 200 characters. */
  detail?: string;
  /** The engine's `Retry-After`, in seconds, when it sent one as a number (e.g. a `503` at `STREMIO_MAX_ENGINES`). */
  retryAfterSec?: number;

  constructor(endpoint: string, message: string, status?: number) {
    super(message);
    this.endpoint = endpoint;
    this.status = status;
  }
}
