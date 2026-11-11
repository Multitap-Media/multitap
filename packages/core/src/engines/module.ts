/**
 * The engine module's contract (okf:architecture/engine-module): turns a raw addon `Stream`
 * into a playable HLS session on an engine. It knows nothing about playback
 * sessions beyond an opaque key, and nothing about how the stream was chosen.
 * It is the only code that knows `Stream` internals and engine APIs. Types
 * only; phase 2 step 3 implements it (engines/engine-module.ts).
 */
import type { EngineStatus, SessionQuality, SessionTracks } from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';
import type { EnginePrepareStatus, OpenSubHash, PrepareAudio } from './server-go-types.ts';

/**
 * Identifies one engine session. Opaque outside the engine module: callers
 * store it (as `engine_id` + `sid` on the playback session) and hand it back.
 */
export interface EngineHandle {
  readonly engineId: string;
  readonly sid: string;
  /** Overrides the engine applied when it created the session; absent = its defaults (okf:architecture/rendition-and-bandwidth). */
  readonly quality?: SessionQuality;
}

export interface PrepareRequest {
  engineId: string;
  /** The playback session id. With the stream and quality, it selects the engine session (okf:architecture/engine-prepare-stream). */
  sessionKey: string;
  /** Raw, exactly as the addon returned it. Secret. */
  stream: Stream;
  /**
   * `full` makes a session to prepare ahead (okf:architecture/engine-prepare-ahead): the source may
   * be as tall as `preparedMaxHeight`, nothing is warmed, the engine must have
   * preparation, and the session gets the prepared `ttl`. The job itself is
   * started with {@link EngineModule.startPrepare}.
   */
  mode: 'play' | 'full';
  /**
   * Requested overrides, already capped by the caller at `liveMaxHeight` and
   * `MULTITAP_SESSION_MAX_BITRATE`. Sent only to an engine with `sessionOverrides`;
   * part of the engine session's identity.
   */
  quality?: SessionQuality;
  /**
   * Whether a live source may be played through the engine's HLS proxy,
   * without a transcode (okf:architecture/media-gateway). Off: a live source is
   * unplayable (`live`), as it is in mode `full`.
   */
  allowLive?: boolean;
  /** Reports `status` changes while preparing, for `session.status` events. */
  onStatus?: (status: EngineStatus) => void;
  signal?: AbortSignal;
}

/**
 * Why a stream can't play. Coarse on purpose (okf:decision/auto-select-and-fallback): callers only decide
 * whether to fall back.
 * - `unsupported`: a stream kind the module doesn't handle (archives, NZB, …)
 * - `external`: `externalUrl` only
 * - `live`: a live source where one can't be played: the request asked for a
 *   transcode or a preparation, or the engine has no HLS proxy
 * - `needs-prepare`: the probe found a height above `liveMaxHeight` in mode `play`
 * - `probe-failed`: the probe failed, or found zero duration for VOD
 * - `torrent-failed`: create timed out or found no file
 * - `engine-offline`: the engine didn't answer
 * - `engine-error`: the engine answered with an unexpected status
 * - `engine-busy`: the engine refused a torrent create with `503` (at its
 *   `STREMIO_MAX_ENGINES` cap), again after waiting its `Retry-After` once
 * - `prepare-unsupported`: mode `full` on an engine without engine-side
 *   preparation (okf:architecture/engine-prepare-ahead)
 */
export const UNPLAYABLE_ENGINE_REASONS = [
  'unsupported',
  'external',
  'live',
  'needs-prepare',
  'probe-failed',
  'torrent-failed',
  'engine-offline',
  'engine-error',
  'engine-busy',
  'prepare-unsupported',
] as const;
export type UnplayableEngineReason = (typeof UNPLAYABLE_ENGINE_REASONS)[number];

export type PrepareResult =
  | {
      ok: true;
      handle: EngineHandle;
      status: EngineStatus;
      /** The audio and subtitle tracks the session's master offers, in rendition order (from the probe). */
      tracks?: SessionTracks;
      /** A live source, proxied and not transcoded: no quality, no tracks, no engine HLS session. */
      live?: boolean;
    }
  | { ok: false; reason: UnplayableEngineReason; retryable: boolean };

/** What the engine said about a session's preparation job (okf:architecture/engine-prepare-ahead). */
export type EnginePrepareResult =
  | { kind: 'status'; status: EnginePrepareStatus }
  /** The engine has no such session, and it couldn't be made again. */
  | { kind: 'lost' }
  /** The engine has no engine-side preparation. */
  | { kind: 'unsupported' }
  /** The session's duration is unknown to the engine. */
  | { kind: 'no-duration' }
  /** The prepared session wouldn't fit the engine's segment cache cap. */
  | { kind: 'too-large' };

export interface EngineModule {
  /**
   * okf:architecture/engine-prepare-stream: find or mint the engine session id, resolve `mediaURL` (the matrix),
   * probe, create the session with the master request, and warm `seg0`–`seg2`
   * in the background. Never throws for an unplayable stream; rejects only on
   * programming or database errors.
   */
  prepare(request: PrepareRequest): Promise<PrepareResult>;

  /** The latest known status (phases, peers and speed from stats, probe info). */
  status(handle: EngineHandle): EngineStatus;

  /**
   * `DELETE /hlsv2/{sid}` when the engine supports it, otherwise a logged
   * no-op (okf:architecture/engine-retention). Rejects when the engine doesn't confirm; the release then
   * stays pending for {@link retryReleases}.
   */
  release(handle: EngineHandle): Promise<void>;

  /**
   * Retries pending releases that are due, with backoff, until the engine
   * confirms each session is gone (okf:architecture/engine-retention). The retention sweep calls it.
   */
  retryReleases(): Promise<{ released: number; pending: number }>;

  /**
   * Only the gateway calls this. `file` is already allowlisted (okf:architecture/media-gateway).
   * `master.m3u8` always goes through `master.m3u8?mediaURL=…` so an evicted
   * session is recreated (self-heal, okf:architecture/engine-session-lifecycle). Returns the engine's response
   * unbuffered; the caller streams it and decides what an abort does.
   *
   * For a live session, `master.m3u8` and every `live/…m3u8` are the engine's
   * proxied playlists with their children renamed to `live/…` files; the other
   * `live/…` files are passed through, with `options.range` sent on.
   */
  fetchMedia(
    handle: EngineHandle,
    file: string,
    signal?: AbortSignal,
    options?: { range?: string | undefined },
  ): Promise<Response>;

  /**
   * Starts (or re-checks) the engine's preparation job of a session made with
   * mode `full`. A session the engine no longer has is made again first, as
   * for a master request. Rejects when the engine doesn't answer or answers
   * unexpectedly. Optional: without it nothing can be prepared.
   */
  startPrepare?(handle: EngineHandle, audio: PrepareAudio): Promise<EnginePrepareResult>;

  /** The engine's progress on a session's preparation job. Rejects like {@link startPrepare}. */
  prepareStatus?(handle: EngineHandle): Promise<EnginePrepareResult>;

  /**
   * The OpenSubtitles hash and size of the session's source, read by the
   * engine (`/opensubHash`), for subtitle requests (�5.2). Undefined when the
   * engine can't tell (no such endpoint, or the session is unknown); rejects on
   * a failed read. Optional: a module without it just gives no hash.
   */
  openSubHash?(handle: EngineHandle, signal?: AbortSignal): Promise<OpenSubHash | undefined>;
}
