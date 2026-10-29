/**
 * The engine module (okf:architecture/engine-module–7.4, phase 2 step 3) for
 * stremio-server-go engines. Turns a raw `Stream` into an HLS session:
 * engine session id lookup or mint, the resolution matrix, probe, the
 * creating master request (with per-session quality on an engine with
 * `sessionOverrides`), and a background warm-up of the first segments.
 * The gateway reaches media only through {@link ServerGoEngineModule.fetchMedia},
 * whose master request always carries `mediaURL` so an evicted or restarted
 * session is recreated (self-heal, okf:architecture/engine-session-lifecycle).
 *
 * `mediaURL`s and raw streams are secrets (okf:architecture/secrets-policy): they are stored only in
 * `engine_sessions.media_url` and never logged at `info` and above. The
 * engine's proxy password is added to a `/proxy/stream` `mediaURL` only on the
 * way out (probe and master requests), so it is never stored with it and never
 * logged, `debug` included.
 *
 * A release the engine doesn't confirm (unreachable, or an unexpected status)
 * leaves the `engine_sessions` row pending; {@link ServerGoEngineModule.retryReleases},
 * called by the retention sweep, retries it with backoff until the engine
 * answers that the session is deleted or gone (okf:architecture/engine-retention).
 */
import type {
  EngineDescriptor,
  EngineMediaInfo,
  EngineStatus,
  MediaTrack,
  SessionQuality,
  SessionTracks,
} from '@multitap/api';
import { HDR_FORMATS } from '@multitap/api';
import {
  defaultPrivateHostGuard,
  parseAddress,
  type PrivateHostGuard,
} from '@multitap/addon-protocol';
import type { Db } from '../db/index.ts';
import { sql } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { IdGenerator } from '../lib/ids.ts';
import type { Logger } from '../log.ts';
import type {
  EngineHandle,
  EngineModule,
  PrepareRequest,
  PrepareResult,
  UnplayableEngineReason,
} from './module.ts';
import type { EngineEntry, EngineRegistry } from './registry.ts';
import {
  normalizeQuality,
  planStream,
  qualityKey as toQualityKey,
  streamHash as toStreamHash,
  trackersOf,
  type StreamPlan,
} from './resolve.ts';
import { readEngineDetail } from './server-go.ts';
import {
  ServerGoError,
  type OpenSubHash,
  type ProbeResult,
  type ProbeStream,
  type ServerGoClient,
} from './server-go-types.ts';
import { EngineTransportError } from './transport.ts';

/** `fetchMedia` for a handle Multitap has no engine session for (released, or never prepared). */
export class EngineSessionNotFoundError extends Error {
  override name = 'EngineSessionNotFoundError';
  readonly engineId: string;
  readonly sid: string;
  constructor(handle: EngineHandle) {
    super('no such engine session');
    this.engineId = handle.engineId;
    this.sid = handle.sid;
  }
}

export interface EngineModuleOptions {
  db: Db;
  registry: EngineRegistry;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /** Segments warmed per rendition after create (okf:architecture/engine-prepare-stream step 5). Default 3 (`seg0`–`seg2`); 0 turns warming off. */
  warmSegments?: number;
  /** Torrent stats are refreshed in the background when older than this. Default 5 s. */
  statsRefreshMs?: number;
  /**
   * Per-session engine TTL in seconds (#25), sent on master requests to an
   * engine with `sessionOverrides`: a safety net for sessions Multitap fails to
   * delete (okf:architecture/engine-retention). Default: none (`MULTITAP_ENGINE_SESSION_TTL_MS` unset).
   */
  sessionTtlSec?: number;
  /** First retry of a failed engine release after this long; doubles per failure. Default 60 s. */
  releaseRetryBaseMs?: number;
  /** Longest wait between release retries. Default 5 min. */
  releaseRetryMaxMs?: number;
  /**
   * Longest wait before retrying a torrent create the engine refused with
   * `503` (its `STREMIO_MAX_ENGINES` cap): its `Retry-After`, default 5 s,
   * capped here. Default 10 s.
   */
  busyRetryMaxMs?: number;
  /**
   * Checks the target of a `proxy` plan before the engine gets it with its
   * proxy password: a private host only when `MULTITAP_ADDON_PRIVATE_ALLOW`
   * lists it (okf:architecture/addon-private-host-guard). Default: no allowlist.
   */
  privateHosts?: PrivateHostGuard;
}

interface SessionState {
  engineId: string;
  sid: string;
  mediaURL: string;
  applied: SessionQuality | undefined;
  status: EngineStatus;
  torrent?: { infoHash: string; fileIdx: number };
  statsAt: number;
  statsRefreshing: boolean;
  warm: AbortController;
}

interface Failure {
  ok: false;
  reason: UnplayableEngineReason;
  retryable: boolean;
}

const fail = (reason: UnplayableEngineReason, retryable: boolean): Failure => ({
  ok: false,
  reason,
  retryable,
});

/** Non-secret engine detail for the `stream unplayable` log line. */
interface EngineDetail {
  engineStatus?: number;
  engineError?: string;
}

function detailOf(err: unknown): EngineDetail {
  if (!(err instanceof ServerGoError)) return {};
  const out: EngineDetail = {};
  if (err.status !== undefined) out.engineStatus = err.status;
  if (err.detail !== undefined) out.engineError = err.detail;
  return out;
}

const handleKey = (engineId: string, sid: string) => `${engineId}\u0000${sid}`;

/** The `mediaURL` to send: plus `api_password` on this engine's `/proxy/stream` URLs (okf:architecture/secrets-classes-and-engine-password). */
const withPassword = (entry: EngineEntry, mediaURL: string) =>
  entry.client.withApiPassword(mediaURL, entry.proxyPassword?.reveal());

/**
 * Whether an addon's own URL points at loopback or at the engine's host. The
 * engine would take its own `/proxy/stream` there as a media URL, so such a
 * source is refused (okf:core-review/sec-input-engine-proxy-password).
 */
function pointsAtEngine(url: string, engineAddress: string | null): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  try {
    if (engineAddress !== null && host === new URL(engineAddress).hostname.toLowerCase()) {
      return true;
    }
  } catch {
    // An engine address that isn't a URL matches nothing.
  }
  const bytes = parseAddress(host);
  if (bytes === undefined) return false;
  // 127/8 and 0.0.0.0; ::1 and ::. IPv4-mapped addresses arrive as IPv4.
  if (bytes.length === 4) return bytes[0] === 127 || bytes.every((b) => b === 0);
  return bytes.slice(0, 15).every((b) => b === 0) && (bytes[15] ?? 0) <= 1;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (err instanceof EngineTransportError && err.code === 'aborted') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Maps an engine call failure to a coarse reason; rethrows aborts and programming errors. */
function engineFailure(err: unknown, signal: AbortSignal | undefined): Failure {
  if (isAbort(err, signal)) throw err;
  if (err instanceof EngineTransportError) return fail('engine-offline', true);
  if (err instanceof ServerGoError) return fail('engine-error', true);
  throw err;
}

/** The video stream the engine transcodes: the default one, else the first. */
function videoOf(probe: ProbeResult) {
  const videos = probe.streams.filter((s) => s.track === 'video');
  return videos.find((s) => s.default === true) ?? videos[0];
}

function mediaInfo(probe: ProbeResult): EngineMediaInfo {
  const info: EngineMediaInfo = { durationSec: probe.durationSec };
  const video = videoOf(probe);
  if (video !== undefined) {
    if (video.height !== undefined) info.height = video.height;
    if (video.width !== undefined) info.width = video.width;
    if (video.codec !== '') info.codec = video.codec;
    const hdr = video.hdr?.toLowerCase();
    if (hdr !== undefined && (HDR_FORMATS as readonly string[]).includes(hdr)) {
      info.hdr = hdr as EngineMediaInfo['hdr'];
    }
  }
  return info;
}

/**
 * Subtitle codecs server-go turns into WebVTT renditions (its `probeMedia`
 * keeps these and drops image subtitles), so a track's index here is its
 * `sub<k>.m3u8` rendition.
 */
const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'jacosub',
  'realtext',
  'sami',
  'subviewer',
]);

/**
 * The tracks a server-go master offers for this probe, in rendition order:
 * every audio stream (`audio<k>.m3u8` when there are two or more) and every
 * text subtitle stream (`sub<k>.m3u8`), both in the probe's stream order, as
 * server-go numbers them.
 */
export function tracksOf(probe: ProbeResult): SessionTracks {
  const track = (s: ProbeStream, index: number): MediaTrack => {
    const out: MediaTrack = { index, default: s.default === true };
    if (s.lang !== undefined && s.lang !== '') out.lang = s.lang;
    if (s.codec !== '') out.codec = s.codec;
    if (s.track === 'audio' && s.channels !== undefined) out.channels = s.channels;
    return out;
  };
  return {
    audio: probe.streams.filter((s) => s.track === 'audio').map(track),
    subtitles: probe.streams
      .filter((s) => s.track === 'subtitle' && TEXT_SUBTITLE_CODECS.has(s.codec.toLowerCase()))
      .map(track),
  };
}

/** Variant and default-audio rendition URIs from a server-go master playlist. */
export function warmPlaylists(master: string): string[] {
  const uris: string[] = [];
  for (const raw of master.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (
      line.startsWith('#EXT-X-MEDIA:') &&
      line.includes('TYPE=AUDIO') &&
      line.includes('DEFAULT=YES')
    ) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri !== undefined) uris.push(uri);
    } else if (!line.startsWith('#')) {
      uris.push(line);
    }
  }
  return [...new Set(uris)].filter((uri) => !uri.includes('/') && !uri.includes(':'));
}

/** The first `count` segment URIs of a media playlist. */
export function firstSegments(playlist: string, count: number): string[] {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .filter((uri) => !uri.includes('/') && !uri.includes(':'))
    .slice(0, count);
}

/** The module's options from Multitap's config (okf:architecture/engine-retention, okf:architecture/configuration). */
export function engineModuleConfig(config: {
  engines: { sessionTtlMs: number | null; healthMaxBackoffMs: number };
  sessions: { sweepIntervalMs: number };
}): Pick<EngineModuleOptions, 'sessionTtlSec' | 'releaseRetryBaseMs' | 'releaseRetryMaxMs'> {
  return {
    ...(config.engines.sessionTtlMs === null
      ? {}
      : { sessionTtlSec: Math.ceil(config.engines.sessionTtlMs / 1000) }),
    releaseRetryBaseMs: config.sessions.sweepIntervalMs,
    releaseRetryMaxMs: config.engines.healthMaxBackoffMs,
  };
}

export class ServerGoEngineModule implements EngineModule {
  readonly #o: EngineModuleOptions;
  readonly #warmSegments: number;
  readonly #statsRefreshMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #busyRetryMaxMs: number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #inflight = new Map<string, Promise<PrepareResult>>();
  readonly #background = new Set<Promise<unknown>>();

  constructor(options: EngineModuleOptions) {
    this.#o = options;
    this.#warmSegments = options.warmSegments ?? 3;
    this.#statsRefreshMs = options.statsRefreshMs ?? 5_000;
    this.#retryBaseMs = options.releaseRetryBaseMs ?? 60_000;
    this.#retryMaxMs = Math.max(this.#retryBaseMs, options.releaseRetryMaxMs ?? 5 * 60_000);
    this.#busyRetryMaxMs = Math.max(0, options.busyRetryMaxMs ?? 10_000);
  }

  /** Resolves when background work (warm-ups, stats refreshes) has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Aborts every warm-up (shutdown). */
  close(): void {
    for (const state of this.#sessions.values()) state.warm.abort();
  }

  prepare(request: PrepareRequest): Promise<PrepareResult> {
    if (request.mode !== 'play') {
      return Promise.reject(new Error("engine module: mode 'full' is phase 4"));
    }
    const key = [
      request.engineId,
      request.sessionKey,
      toStreamHash(request.stream),
      JSON.stringify(request.quality ?? null),
    ].join('\u0000');
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = this.#prepare(request).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  async #prepare(request: PrepareRequest): Promise<PrepareResult> {
    const { db, registry, logger, clock, ids } = this.#o;
    const log = logger.child({ engineId: request.engineId, sessionKey: request.sessionKey });
    let phase: EngineStatus['phase'] | undefined;
    const report = (status: EngineStatus) => {
      phase = status.phase;
      try {
        request.onStatus?.(status);
      } catch (err) {
        log.warn({ err }, 'engine module: onStatus listener threw');
      }
    };
    let torrentRef: SessionState['torrent'] | undefined;
    const ctx: { client?: ServerGoClient; secret?: string } = {};
    // Logs why a source was judged unplayable, with non-secret engine detail only:
    // never URLs, headers, tokens or the proxy password.
    const failed = async (
      result: Failure & { detail?: EngineDetail },
      err?: unknown,
    ): Promise<Failure> => {
      const { detail: own, ...plain } = result;
      const detail: EngineDetail = { ...own, ...detailOf(err) };
      const fields: Record<string, unknown> = {
        reason: plain.reason,
        retryable: plain.retryable,
      };
      if (phase !== undefined) fields.phase = phase;
      if (detail.engineStatus !== undefined) fields.engineStatus = detail.engineStatus;
      if (detail.engineError !== undefined && detail.engineError !== '') {
        let text = detail.engineError;
        if (ctx.secret !== undefined && ctx.secret !== '') {
          text = text.split(ctx.secret).join('[redacted]');
        }
        fields.engineError = text;
      }
      if (ctx.client !== undefined && torrentRef !== undefined) {
        try {
          const stats = await ctx.client.torrentStats(torrentRef.infoHash, torrentRef.fileIdx);
          if (stats !== undefined) {
            fields.torrentPeers = stats.peers;
            fields.torrentDownloadSpeed = stats.downloadSpeed;
          }
        } catch {
          // Best effort: the engine may be what failed.
        }
      }
      log.info(fields, 'stream unplayable');
      report({ phase: 'failed' });
      return plain;
    };

    const entry = await registry.get(request.engineId);
    if (entry === undefined) return failed(fail('engine-offline', false));
    if (registry.isOnline(request.engineId) === false) return failed(fail('engine-offline', true));
    const { engine, client } = entry;
    ctx.client = client;
    const password = entry.proxyPassword?.reveal();
    if (password !== undefined) ctx.secret = password;
    const plan = planStream(request.stream);
    if (plan.kind === 'unplayable') return failed(fail(plan.reason, false));
    // The proxy password goes only on the `/proxy/stream` URL Multitap builds
    // for a `proxy` plan, and only to a target the private-host guard allows;
    // an addon's own URL never points the engine at itself
    // (okf:core-review/sec-input-engine-proxy-password).
    if (plan.kind === 'url' && pointsAtEngine(plan.url, engine.address)) {
      log.warn('stream refused: its url points at loopback or at the engine');
      return failed(fail('unsupported', false));
    }
    if (plan.kind === 'proxy') {
      let allowed: boolean | undefined;
      try {
        allowed = await (this.#o.privateHosts ?? defaultPrivateHostGuard).allowsUrl(
          new URL(plan.url),
        );
      } catch {
        allowed = false;
      }
      if (allowed === false) {
        log.warn(
          'stream refused: its proxyHeaders target is a private host not in MULTITAP_ADDON_PRIVATE_ALLOW',
        );
        return failed(fail('unsupported', false));
      }
    }
    // What the engine is sent: the mediaURL, plus the proxy password on a `proxy` plan's.
    const outbound = (url: string) => (plan.kind === 'proxy' ? withPassword(entry, url) : url);

    // Quality is applied, and part of the engine session's identity, only where the engine can apply it.
    const requested = normalizeQuality(request.quality);
    const applied = engine.capabilities.sessionOverrides ? requested : undefined;
    if (requested !== undefined && applied === undefined) {
      log.warn('engine has no sessionOverrides; requested quality not applied');
    }
    const hash = toStreamHash(request.stream);
    const qKey = toQualityKey(applied);

    const row = await db
      .selectFrom('engine_sessions')
      .select(['sid'])
      .where('engine_id', '=', request.engineId)
      .where('session_key', '=', request.sessionKey)
      .where('stream_hash', '=', hash)
      .where('quality_key', '=', qKey)
      .executeTakeFirst();
    const sid = row?.sid ?? ids.engineSession();

    // Step 2: mediaURL.
    let mediaURL: string;
    let torrent: SessionState['torrent'];
    if (plan.kind === 'torrent') {
      report({ phase: 'metadata' });
      if (plan.fileIdx !== undefined) {
        torrentRef = { infoHash: plan.infoHash, fileIdx: plan.fileIdx };
      }
      const resolved = await this.#resolveTorrent(client, plan, request.signal);
      if (!resolved.ok) return failed(resolved);
      torrent = { infoHash: plan.infoHash, fileIdx: resolved.fileIdx };
      torrentRef = torrent;
      // The create's trackers ride along in mediaURL (`tr`, as stremio-core does): the
      // engine reopens the torrent from mediaURL alone after a restart or an idle drop.
      mediaURL = client.torrentMediaURL(plan.infoHash, resolved.fileIdx, trackersOf(plan.sources));
    } else if (plan.kind === 'url') {
      mediaURL = plan.url;
    } else if (plan.kind === 'proxy') {
      mediaURL = client.proxyStreamMediaURL({
        url: plan.url,
        requestHeaders: plan.requestHeaders,
        responseHeaders: plan.responseHeaders,
      });
    } else {
      mediaURL = client.youtubeMediaURL(plan.ytId);
    }

    // Step 3: probe.
    report({ phase: 'probing' });
    let probe: ProbeResult;
    try {
      probe = await client.probe(outbound(mediaURL), request.signal);
    } catch (err) {
      if (err instanceof ServerGoError && plan.kind === 'proxy') {
        log.warn(
          { proxyPasswordSet: entry.proxyPassword !== undefined },
          "probe of a proxyHeaders source failed; if the engine sets STREMIO_PROXY_PASSWORD, check the engine's proxyPassword",
        );
      }
      if (err instanceof ServerGoError) {
        // A torrent may just lack peers yet; the engine's negative-probe window is short.
        return failed(fail('probe-failed', plan.kind === 'torrent'), err);
      }
      return failed(engineFailure(err, request.signal), err);
    }
    if (!(probe.durationSec > 0)) {
      const hls = (plan.kind === 'url' || plan.kind === 'proxy') && plan.hls;
      const isHlsFormat = probe.formatName?.split(',').includes('hls') === true;
      if (hls || isHlsFormat) return failed(fail('live', false));
      return failed(fail('probe-failed', plan.kind === 'torrent'));
    }
    const info = mediaInfo(probe);
    if (info.height !== undefined && info.height > engine.capabilities.liveMaxHeight) {
      return failed(fail('needs-prepare', false));
    }

    // Step 4: create the session.
    const overrides = this.#overrides(engine, applied);
    let master: string;
    try {
      const res = await client.master({
        sid,
        mediaURL: outbound(mediaURL),
        overrides,
        signal: request.signal,
      });
      if (res.status !== 200) {
        const engineError = await readEngineDetail(res);
        log.warn({ status: res.status }, 'engine refused the master request');
        // 400: an override out of the engine's range (the caller caps them, so this is a bug or a mismatch).
        return await failed({
          ...fail('engine-error', res.status >= 500),
          detail: { engineStatus: res.status, engineError },
        });
      }
      master = await res.text();
    } catch (err) {
      if (isAbort(err, request.signal)) {
        // Aborted mid-create: the engine may have made the session anyway. Best
        // effort; a row of an earlier prepare stays pending if the delete fails.
        this.#track(this.release({ engineId: request.engineId, sid }).catch(() => undefined));
      }
      return failed(engineFailure(err, request.signal), err);
    }

    const now = clock();
    const appliedJson = applied === undefined ? null : JSON.stringify(applied);
    if (row === undefined) {
      await db
        .insertInto('engine_sessions')
        .values({
          sid,
          engine_id: request.engineId,
          session_key: request.sessionKey,
          stream_hash: hash,
          quality_key: qKey,
          applied_quality_json: appliedJson,
          media_url: mediaURL,
          created_at: now,
          last_used: now,
        })
        .execute();
    } else {
      await db
        .updateTable('engine_sessions')
        .set({
          media_url: mediaURL,
          applied_quality_json: appliedJson,
          last_used: now,
          // Wanted again: a release still pending for it is cancelled.
          release_pending_since: null,
          release_attempts: 0,
          release_next_at: null,
        })
        .where('engine_id', '=', request.engineId)
        .where('sid', '=', sid)
        .execute();
    }

    const status: EngineStatus = { phase: 'ready', info };
    const previous = this.#sessions.get(handleKey(request.engineId, sid));
    previous?.warm.abort();
    const state: SessionState = {
      engineId: request.engineId,
      sid,
      mediaURL,
      applied,
      status,
      statsAt: 0,
      statsRefreshing: false,
      warm: new AbortController(),
    };
    if (torrent !== undefined) state.torrent = torrent;
    this.#sessions.set(handleKey(request.engineId, sid), state);
    report(status);
    log.debug({ sid, mediaURL, applied }, 'engine session created');

    // Step 5: warm the start in the background.
    if (this.#warmSegments > 0) this.#track(this.#warm(client, state, master));

    const handle: EngineHandle =
      applied === undefined
        ? { engineId: request.engineId, sid }
        : { engineId: request.engineId, sid, quality: applied };
    return { ok: true, handle, status, tracks: tracksOf(probe) };
  }

  async #resolveTorrent(
    client: ServerGoClient,
    plan: Extract<StreamPlan, { kind: 'torrent' }>,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; fileIdx: number } | (Failure & { detail?: EngineDetail })> {
    if (signal?.aborted === true) throw signal.reason;
    const create = () =>
      client.createTorrent(plan.infoHash, {
        ...(signal === undefined ? {} : { signal }),
        sources: plan.sources,
        ...(plan.fileIdx === undefined
          ? { guessFileIdx: true, fileMustInclude: plan.fileMustInclude }
          : {}),
      });
    try {
      let stats: Awaited<ReturnType<typeof create>>;
      try {
        stats = await create();
      } catch (err) {
        // 503: the engine is at its active-torrent cap (STREMIO_MAX_ENGINES) and
        // had no idle torrent to evict. One may go idle soon: wait its
        // Retry-After once, then report engine-busy.
        if (!(err instanceof ServerGoError && err.status === 503)) throw err;
        const waitMs = Math.min((err.retryAfterSec ?? 5) * 1000, this.#busyRetryMaxMs);
        this.#o.logger.info(
          { engineId: client.engineId, waitMs },
          'engine at its torrent cap; retrying the create once',
        );
        await sleep(waitMs, signal);
        try {
          stats = await create();
        } catch (again) {
          if (again instanceof ServerGoError && again.status === 503) {
            return { ...fail('engine-busy', true), detail: detailOf(again) };
          }
          throw again;
        }
      }
      const fileIdx = plan.fileIdx ?? stats.guessedFileIdx;
      if (fileIdx === undefined) return fail('torrent-failed', false);
      if (stats.files.length > 0 && fileIdx >= stats.files.length) {
        return fail('torrent-failed', false);
      }
      return { ok: true, fileIdx };
    } catch (err) {
      // 504: no metadata within STREMIO_CREATE_METADATA_TIMEOUT (no peers yet).
      if (err instanceof ServerGoError && err.status === 504) {
        return { ...fail('torrent-failed', true), detail: detailOf(err) };
      }
      return { ...engineFailure(err, signal), detail: detailOf(err) };
    }
  }

  #overrides(engine: EngineDescriptor, applied: SessionQuality | undefined) {
    if (!engine.capabilities.sessionOverrides) return undefined;
    const overrides: { maxHeight?: number; bitrate?: number; ttlSec?: number } = {};
    if (applied?.maxHeight !== undefined) overrides.maxHeight = applied.maxHeight;
    if (applied?.bitrate !== undefined) overrides.bitrate = applied.bitrate;
    if (this.#o.sessionTtlSec !== undefined) overrides.ttlSec = this.#o.sessionTtlSec;
    return Object.keys(overrides).length === 0 ? undefined : overrides;
  }

  async #warm(client: ServerGoClient, state: SessionState, master: string): Promise<void> {
    const signal = state.warm.signal;
    const log = this.#o.logger.child({ engineId: state.engineId, sid: state.sid });
    const fetchText = async (file: string) => {
      const res = await client.file(state.sid, file, signal);
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new ServerGoError('warm', `engine answered ${String(res.status)}`, res.status);
      }
      return res.text();
    };
    const drain = async (file: string) => {
      const res = await client.file(state.sid, file, signal);
      // Read to the end: the engine caches a segment only once its transcode completes.
      await res.arrayBuffer();
    };
    await Promise.all(
      warmPlaylists(master).map(async (playlist) => {
        try {
          const text = await fetchText(playlist);
          for (const segment of firstSegments(text, this.#warmSegments)) {
            if (signal.aborted) return;
            await drain(segment);
          }
        } catch (err) {
          if (!signal.aborted) log.debug({ err, playlist }, 'warm-up failed');
        }
      }),
    );
  }

  status(handle: EngineHandle): EngineStatus {
    const state = this.#sessions.get(handleKey(handle.engineId, handle.sid));
    // A handle exists only after a successful prepare; after a Multitap restart nothing is cached.
    if (state === undefined) return { phase: 'ready' };
    if (
      state.torrent !== undefined &&
      !state.statsRefreshing &&
      this.#o.clock() - state.statsAt >= this.#statsRefreshMs
    ) {
      state.statsRefreshing = true;
      this.#track(this.#refreshStats(state));
    }
    return state.status;
  }

  /** Fetches torrent stats now and returns the updated status (status() does it in the background). */
  async refreshStatus(handle: EngineHandle): Promise<EngineStatus> {
    const state = this.#sessions.get(handleKey(handle.engineId, handle.sid));
    if (state === undefined) return { phase: 'ready' };
    if (state.torrent !== undefined) await this.#refreshStats(state);
    return state.status;
  }

  async #refreshStats(state: SessionState): Promise<void> {
    const torrent = state.torrent;
    if (torrent === undefined) return;
    try {
      const entry = await this.#o.registry.get(state.engineId);
      if (entry === undefined) return;
      const stats = await entry.client.torrentStats(torrent.infoHash, torrent.fileIdx);
      if (stats !== undefined) {
        state.status = { ...state.status, peers: stats.peers, downloadSpeed: stats.downloadSpeed };
      }
    } catch (err) {
      this.#o.logger.debug({ err, engineId: state.engineId }, 'torrent stats failed');
    } finally {
      state.statsAt = this.#o.clock();
      state.statsRefreshing = false;
    }
  }

  /**
   * Deletes the engine session and its row. When the engine doesn't confirm
   * (unreachable, or an unexpected status), the row is kept as a pending
   * release for {@link retryReleases} and the error is rethrown.
   */
  async release(handle: EngineHandle): Promise<void> {
    const key = handleKey(handle.engineId, handle.sid);
    this.#sessions.get(key)?.warm.abort();
    this.#sessions.delete(key);
    try {
      await this.#deleteOnEngine(handle);
    } catch (err) {
      await this.#markReleasePending(handle);
      throw err;
    }
    await this.#forgetRow(handle);
  }

  /**
   * Retries the pending releases that are due (okf:architecture/engine-retention), skipping engines the
   * health check sees offline. A `204` or a `404` (already gone, e.g. after an
   * engine restart without persistence) ends one, and so do an engine without
   * `DELETE` and a removed engine. Returns how many ended and how many are
   * still pending.
   */
  async retryReleases(): Promise<{ released: number; pending: number }> {
    const { db, registry, logger, clock } = this.#o;
    const due = await db
      .selectFrom('engine_sessions')
      .select(['engine_id', 'sid'])
      .where('release_pending_since', 'is not', null)
      .where('release_next_at', '<=', clock())
      .orderBy('release_next_at')
      .execute();
    let released = 0;
    for (const row of due) {
      if (registry.isOnline(row.engine_id) === false) continue;
      const handle: EngineHandle = { engineId: row.engine_id, sid: row.sid };
      try {
        await this.#deleteOnEngine(handle);
      } catch (err) {
        const attempts = await this.#markReleasePending(handle);
        logger.debug(
          { err, engineId: row.engine_id, sid: row.sid, attempts },
          'engine release retry failed',
        );
        continue;
      }
      await this.#forgetRow(handle);
      released += 1;
      logger.info({ engineId: row.engine_id, sid: row.sid }, 'engine session released on retry');
    }
    const { pending } = await db
      .selectFrom('engine_sessions')
      .select((eb) => eb.fn.countAll<number>().as('pending'))
      .where('release_pending_since', 'is not', null)
      .executeTakeFirstOrThrow();
    return { released, pending };
  }

  /** `DELETE /hlsv2/{sid}`; resolves once the engine has no such session (or can't delete). */
  async #deleteOnEngine(handle: EngineHandle): Promise<void> {
    const { registry, logger } = this.#o;
    const entry = await registry.get(handle.engineId);
    // A removed engine: nothing to delete on.
    if (entry === undefined) return;
    // Rejects when the engine can't be reached or answers unexpectedly.
    const result = await entry.client.deleteSession(handle.sid);
    if (result === 'unsupported') {
      logger.info(
        { engineId: handle.engineId },
        'engine has no DELETE /hlsv2/{id}; its idle TTL ends the session (no-op release)',
      );
    } else {
      logger.debug(
        { engineId: handle.engineId, sid: handle.sid, result },
        'engine session released',
      );
    }
  }

  /** Records a failed release attempt and schedules the next; returns the attempts so far. */
  async #markReleasePending(handle: EngineHandle): Promise<number> {
    const { db, clock } = this.#o;
    const now = clock();
    const row = await db
      .selectFrom('engine_sessions')
      .select('release_attempts')
      .where('engine_id', '=', handle.engineId)
      .where('sid', '=', handle.sid)
      .executeTakeFirst();
    if (row === undefined) return 0;
    const attempts = row.release_attempts + 1;
    const wait = Math.min(this.#retryBaseMs * 2 ** Math.min(attempts - 1, 30), this.#retryMaxMs);
    await db
      .updateTable('engine_sessions')
      .set({
        release_pending_since: sql<number>`coalesce(release_pending_since, ${now})`,
        release_attempts: attempts,
        release_next_at: now + wait,
      })
      .where('engine_id', '=', handle.engineId)
      .where('sid', '=', handle.sid)
      .execute();
    return attempts;
  }

  async #forgetRow(handle: EngineHandle): Promise<void> {
    await this.#o.db
      .deleteFrom('engine_sessions')
      .where('engine_id', '=', handle.engineId)
      .where('sid', '=', handle.sid)
      .execute();
  }

  async fetchMedia(handle: EngineHandle, file: string, signal?: AbortSignal): Promise<Response> {
    const { db, registry, clock, logger } = this.#o;
    const entry = await registry.get(handle.engineId);
    if (entry === undefined) throw new EngineSessionNotFoundError(handle);
    if (file !== 'master.m3u8') return entry.client.file(handle.sid, file, signal);

    const state = this.#sessions.get(handleKey(handle.engineId, handle.sid));
    let mediaURL = state?.mediaURL;
    let applied = state?.applied;
    if (mediaURL === undefined) {
      const row = await db
        .selectFrom('engine_sessions')
        .select(['media_url', 'applied_quality_json'])
        .where('engine_id', '=', handle.engineId)
        .where('sid', '=', handle.sid)
        .executeTakeFirst();
      if (row === undefined) throw new EngineSessionNotFoundError(handle);
      mediaURL = row.media_url;
      applied =
        row.applied_quality_json === null
          ? undefined
          : (JSON.parse(row.applied_quality_json) as SessionQuality);
    }
    // Self-heal (okf:architecture/engine-session-lifecycle): the master request always carries mediaURL and the
    // session's overrides, so an evicted or forgotten session comes back alike.
    const res = await entry.client.master({
      sid: handle.sid,
      mediaURL: withPassword(entry, mediaURL),
      overrides: this.#overrides(entry.engine, applied),
      signal,
    });
    void db
      .updateTable('engine_sessions')
      .set({ last_used: clock() })
      .where('engine_id', '=', handle.engineId)
      .where('sid', '=', handle.sid)
      .execute()
      .catch((err: unknown) => {
        logger.warn({ err }, 'engine session: storing last_used failed');
      });
    return res;
  }

  async openSubHash(handle: EngineHandle, signal?: AbortSignal): Promise<OpenSubHash | undefined> {
    const { db, registry } = this.#o;
    const entry = await registry.get(handle.engineId);
    if (entry === undefined) return undefined;
    let mediaURL = this.#sessions.get(handleKey(handle.engineId, handle.sid))?.mediaURL;
    mediaURL ??= (
      await db
        .selectFrom('engine_sessions')
        .select('media_url')
        .where('engine_id', '=', handle.engineId)
        .where('sid', '=', handle.sid)
        .executeTakeFirst()
    )?.media_url;
    if (mediaURL === undefined) return undefined;
    return entry.client.openSubHash(withPassword(entry, mediaURL), signal);
  }

  #track(promise: Promise<unknown>): void {
    this.#background.add(promise);
    void promise.finally(() => this.#background.delete(promise));
  }
}
