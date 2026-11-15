/**
 * The typed stremio-server-go client (okf:architecture/engine-endpoints-core-uses, okf:architecture/engine-transport-and-health) over an
 * {@link EngineTransport}. Engine JSON is parsed into the shapes in
 * server-go-types.ts and nothing else reaches callers. Errors never carry a
 * URL: `mediaURL`s are secrets (okf:architecture/secrets-policy).
 */
import { z } from 'zod';
import {
  ServerGoError,
  ZERO_INFO_HASH,
  type DeleteSessionResult,
  type MasterRequest,
  type EnginePrepareStatus,
  type LiveFetchRequest,
  type OpenSubHash,
  type PrepareAudio,
  type PrepareCallResult,
  type ProbeResult,
  type ProbeStream,
  type ProxyStreamRequest,
  type ServerGoClient,
  type TorrentCreateRequest,
  type TorrentStats,
} from './server-go-types.ts';
import type { EngineTransport } from './transport.ts';

/** Per-call budgets (config `engines.timeoutsMs`). */
export interface ServerGoTimeouts {
  /** stats, delete, metrics, capability probes. */
  control: number;
  /** Torrent create, probe, and master requests. */
  prepare: number;
  /** Playlists and segments. */
  media: number;
}

/** server-go's default `HTTP_PORT`. */
export const DEFAULT_ENGINE_PORT = 11470;

/**
 * A session id that server-go's `validSessionID` rejects (it contains `..`),
 * so an engine with `DELETE /hlsv2/{id}` (#24) answers `400`, and one without
 * it routes the request to its generic `404`. The WHATWG URL parser leaves it
 * alone (only exact dot segments are normalised).
 */
export const DELETE_PROBE_ID = '..capability-probe';

const INFO_HASH = /^[0-9a-f]{40}$/;

const StatsSchema = z.looseObject({
  infoHash: z.string().catch(''),
  name: z.string().catch(''),
  peers: z.number().catch(0),
  downloadSpeed: z.number().catch(0),
  files: z
    .array(z.looseObject({ name: z.string().catch(''), length: z.number().catch(0) }))
    .nullish()
    .transform((files) => files ?? []),
  guessedFileIdx: z.number().int().nonnegative().optional().catch(undefined),
  streamLen: z.number().optional().catch(undefined),
  streamProgress: z.number().optional().catch(undefined),
});

const ProbeSchema = z.looseObject({
  duration: z.number().catch(0),
  format: z
    .looseObject({ name: z.string().catch('') })
    .optional()
    .catch(undefined),
  streams: z
    .array(
      z.looseObject({
        index: z.number().catch(0),
        track: z.string().catch(''),
        codec: z.string().catch(''),
        width: z.number().optional().catch(undefined),
        height: z.number().optional().catch(undefined),
        lang: z.string().optional().catch(undefined),
        default: z.boolean().optional().catch(undefined),
        channels: z.number().optional().catch(undefined),
        hdr: z.string().optional().catch(undefined),
        profile: z.string().optional().catch(undefined),
        bitDepth: z.number().optional().catch(undefined),
      }),
    )
    .nullish()
    .transform((streams) => streams ?? []),
});

// Loose, so fields the engine adds later don't break Multitap; counts default to 0.
const prepareCount = z.number().int().nonnegative().catch(0);
const PrepareStatusSchema = z.looseObject({
  state: z.enum(['idle', 'running', 'done', 'failed']),
  total: prepareCount,
  cached: prepareCount,
  uncached: prepareCount,
  failed: prepareCount,
  error: z.string().optional().catch(undefined),
});

const OpenSubHashSchema = z.looseObject({
  result: z.looseObject({
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    size: z.number().int().positive(),
  }),
});

function toStats(parsed: z.output<typeof StatsSchema>): TorrentStats {
  const stats: TorrentStats = {
    infoHash: parsed.infoHash,
    name: parsed.name,
    peers: parsed.peers,
    downloadSpeed: parsed.downloadSpeed,
    files: parsed.files.map((f) => ({ name: f.name, length: f.length })),
  };
  if (parsed.guessedFileIdx !== undefined) stats.guessedFileIdx = parsed.guessedFileIdx;
  if (parsed.streamLen !== undefined) stats.streamLen = parsed.streamLen;
  if (parsed.streamProgress !== undefined) stats.streamProgress = parsed.streamProgress;
  return stats;
}

/** Reads and drops a body we don't need, so the connection is reused. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed.
  }
}

/** A short body's text (at most the first 1 KiB is kept); empty when unreadable. */
async function readBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1_024);
  } catch {
    return '';
  }
}

/** Go's `net/http` answer to a path no route serves (`http.NotFound`). */
export function isRouteNotFound(body: string): boolean {
  return body.trim() === '404 page not found';
}

async function readJson(res: Response, endpoint: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ServerGoError(endpoint, 'engine answered with invalid JSON', res.status);
  }
}

/**
 * An engine error body made safe to log: URLs, `key=value` secrets and long
 * token-like runs are replaced, whitespace is collapsed, and the result is cut
 * to 200 characters. Engines echo upstream errors, which can carry URLs.
 */
export function safeEngineText(raw: string): string {
  return raw
    .slice(0, 2_000)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
    .replace(/\b(api_?password|password|token|api_?key|key|h_[\w-]+)=\S*/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_%.~+/-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The safe text of a non-OK response's body (consumes it); empty when unreadable. */
export async function readEngineDetail(res: Response): Promise<string> {
  try {
    return safeEngineText(await res.text());
  } catch {
    return '';
  }
}

async function unexpected(res: Response, endpoint: string): Promise<ServerGoError> {
  const detail = await readEngineDetail(res);
  const err = new ServerGoError(endpoint, `engine answered ${String(res.status)}`, res.status);
  if (detail !== '') err.detail = detail;
  const retryAfter = res.headers.get('retry-after')?.trim();
  if (retryAfter !== undefined && /^\d{1,6}$/.test(retryAfter))
    err.retryAfterSec = Number(retryAfter);
  return err;
}

/** The engine's loopback origin, from the port in its address (default 11470). */
export function engineSelfBase(address: string | null): string {
  let port = DEFAULT_ENGINE_PORT;
  if (address !== null) {
    try {
      const url = new URL(address);
      if (url.port !== '') port = Number(url.port);
    } catch {
      // Keep the default; the transport rejects a bad address.
    }
  }
  return `http://127.0.0.1:${String(port)}`;
}

export interface ServerGoClientOptions {
  engineId: string;
  transport: EngineTransport;
  timeouts: ServerGoTimeouts;
  /** The engine's own loopback origin; see {@link engineSelfBase}. */
  selfBase?: string;
}

export function createServerGoClient(options: ServerGoClientOptions): ServerGoClient {
  const { engineId, transport, timeouts } = options;
  const selfBase = options.selfBase ?? `http://127.0.0.1:${String(DEFAULT_ENGINE_PORT)}`;
  let deleteSupport: Promise<boolean> | undefined;
  let prepareSupport: Promise<boolean> | undefined;
  let openSubHashSupported = true;

  const checkInfoHash = (infoHash: string) => {
    const ih = infoHash.toLowerCase();
    if (!INFO_HASH.test(ih) || ih === ZERO_INFO_HASH) throw new Error('invalid info hash');
    return ih;
  };
  const checkFileIdx = (fileIdx: number) => {
    if (!Number.isInteger(fileIdx) || fileIdx < 0) throw new Error('invalid file index');
    return fileIdx;
  };
  const sidPath = (sid: string) => encodeURIComponent(sid);

  const probeDelete = async (): Promise<boolean> => {
    const res = await transport.request(`/hlsv2/${encodeURIComponent(DELETE_PROBE_ID)}`, {
      method: 'DELETE',
      timeoutMs: timeouts.control,
    });
    await discard(res);
    if (res.status === 400) return true;
    if (res.status === 404 || res.status === 405) return false;
    throw new ServerGoError('delete-probe', `engine answered ${String(res.status)}`, res.status);
  };

  // `DELETE /hlsv2/{invalid id}/prepare`: the prepare route refuses the id
  // (`400`); an engine without preparation, or with it off, has no such route
  // (`404`), and one without any `DELETE` answers `405`. A `GET` can't tell:
  // without the feature it is a file request, which refuses the id too.
  const probePrepare = async (): Promise<boolean> => {
    const res = await transport.request(`/hlsv2/${encodeURIComponent(DELETE_PROBE_ID)}/prepare`, {
      method: 'DELETE',
      timeoutMs: timeouts.control,
    });
    await discard(res);
    if (res.status === 400) return true;
    if (res.status === 404 || res.status === 405) return false;
    throw new ServerGoError('prepare-probe', `engine answered ${String(res.status)}`, res.status);
  };

  const prepareResult = async (res: Response, endpoint: string): Promise<PrepareCallResult> => {
    if (res.status === 404 || res.status === 409 || res.status === 507) {
      await discard(res);
      if (res.status === 404) return { kind: 'not-found' };
      return { kind: res.status === 409 ? 'no-duration' : 'too-large' };
    }
    if (res.status !== 200 && res.status !== 202) throw await unexpected(res, endpoint);
    const parsed = PrepareStatusSchema.safeParse(await readJson(res, endpoint));
    if (!parsed.success) {
      throw new ServerGoError(endpoint, 'unexpected prepare status shape', res.status);
    }
    const { state, total, cached, uncached, failed, error } = parsed.data;
    const status: EnginePrepareStatus = { state, total, cached, uncached, failed };
    if (error !== undefined && error !== '') status.error = safeEngineText(error);
    return { kind: 'status', status };
  };

  const client: ServerGoClient = {
    engineId,
    transport,
    selfBase,

    async createTorrent(infoHash: string, request: TorrentCreateRequest): Promise<TorrentStats> {
      const ih = checkInfoHash(infoHash);
      const body: Record<string, unknown> = {};
      if (request.sources !== undefined && request.sources.length > 0) {
        body.peerSearch = { sources: request.sources };
      }
      if (request.fileMustInclude !== undefined && request.fileMustInclude.length > 0) {
        body.fileMustInclude = request.fileMustInclude;
      }
      if (request.guessFileIdx === true) body.guessFileIdx = true;
      const res = await transport.request(`/${ih}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: timeouts.prepare,
        signal: request.signal,
      });
      if (res.status !== 200) throw await unexpected(res, 'create');
      const parsed = StatsSchema.safeParse(await readJson(res, 'create'));
      if (!parsed.success) throw new ServerGoError('create', 'unexpected stats shape', res.status);
      return toStats(parsed.data);
    },

    async torrentStats(infoHash: string, fileIdx: number): Promise<TorrentStats | undefined> {
      const ih = checkInfoHash(infoHash);
      const res = await transport.request(`/${ih}/${String(checkFileIdx(fileIdx))}/stats.json`, {
        timeoutMs: timeouts.control,
      });
      if (res.status !== 200) throw await unexpected(res, 'stats');
      const json = await readJson(res, 'stats');
      if (json === null) return undefined;
      const parsed = StatsSchema.safeParse(json);
      if (!parsed.success) throw new ServerGoError('stats', 'unexpected stats shape', res.status);
      return toStats(parsed.data);
    },

    async probe(mediaURL: string, signal?: AbortSignal): Promise<ProbeResult> {
      const res = await transport.request(`/hlsv2/probe?mediaURL=${encodeURIComponent(mediaURL)}`, {
        timeoutMs: timeouts.prepare,
        signal,
      });
      if (res.status !== 200) throw await unexpected(res, 'probe');
      const parsed = ProbeSchema.safeParse(await readJson(res, 'probe'));
      if (!parsed.success) throw new ServerGoError('probe', 'unexpected probe shape', res.status);
      const result: ProbeResult = {
        durationSec: parsed.data.duration,
        streams: parsed.data.streams.map((s) => {
          const out: ProbeStream = { index: s.index, track: s.track, codec: s.codec };
          // server-go reports 0 / '' / false for "not applicable"; keep only real values.
          if (s.width !== undefined && s.width > 0) out.width = s.width;
          if (s.height !== undefined && s.height > 0) out.height = s.height;
          if (s.lang !== undefined && s.lang !== '') out.lang = s.lang;
          if (s.default === true) out.default = true;
          if (s.channels !== undefined && Number.isInteger(s.channels) && s.channels > 0) {
            out.channels = s.channels;
          }
          if (s.hdr !== undefined && s.hdr !== '') out.hdr = s.hdr;
          if (s.profile !== undefined && s.profile !== '') out.profile = s.profile;
          if (s.bitDepth !== undefined && s.bitDepth > 0) out.bitDepth = s.bitDepth;
          return out;
        }),
      };
      const formatName = parsed.data.format?.name;
      if (formatName !== undefined && formatName !== '') result.formatName = formatName;
      return result;
    },

    master(request: MasterRequest): Promise<Response> {
      const params = new URLSearchParams({ mediaURL: request.mediaURL });
      const o = request.overrides;
      if (o?.maxHeight !== undefined) params.set('maxHeight', String(o.maxHeight));
      // Plain bits per second is valid ffmpeg bitrate syntax.
      if (o?.bitrate !== undefined) params.set('bitrate', String(o.bitrate));
      if (o?.ttlSec !== undefined) params.set('ttl', String(o.ttlSec));
      return transport.request(`/hlsv2/${sidPath(request.sid)}/master.m3u8?${params.toString()}`, {
        timeoutMs: request.timeoutMs ?? timeouts.prepare,
        signal: request.signal,
      });
    },

    file(sid: string, file: string, signal?: AbortSignal): Promise<Response> {
      return transport.request(`/hlsv2/${sidPath(sid)}/${encodeURIComponent(file)}`, {
        timeoutMs: timeouts.media,
        signal,
      });
    },

    async deleteSession(sid: string): Promise<DeleteSessionResult> {
      if (!(await client.supportsDelete())) return 'unsupported';
      const res = await transport.request(`/hlsv2/${sidPath(sid)}`, {
        method: 'DELETE',
        timeoutMs: timeouts.control,
      });
      await discard(res);
      if (res.status === 204 || res.status === 200) return 'deleted';
      if (res.status === 404) return 'not-found';
      throw new ServerGoError('delete', `engine answered ${String(res.status)}`, res.status);
    },

    supportsDelete(): Promise<boolean> {
      if (deleteSupport === undefined) {
        const attempt = probeDelete();
        deleteSupport = attempt;
        // Don't cache a failed probe: the engine may simply be offline.
        attempt.catch(() => {
          if (deleteSupport === attempt) deleteSupport = undefined;
        });
      }
      return deleteSupport;
    },

    supportsPrepare(): Promise<boolean> {
      if (prepareSupport === undefined) {
        const attempt = probePrepare();
        prepareSupport = attempt;
        attempt.catch(() => {
          if (prepareSupport === attempt) prepareSupport = undefined;
        });
      }
      return prepareSupport;
    },

    async prepareStart(sid: string, audio: PrepareAudio): Promise<PrepareCallResult> {
      const res = await transport.request(`/hlsv2/${sidPath(sid)}/prepare?audio=${audio}`, {
        method: 'POST',
        timeoutMs: timeouts.control,
      });
      return prepareResult(res, 'prepare');
    },

    async prepareStatus(sid: string): Promise<PrepareCallResult> {
      const res = await transport.request(`/hlsv2/${sidPath(sid)}/prepare`, {
        timeoutMs: timeouts.control,
      });
      return prepareResult(res, 'prepare-status');
    },

    async prepareStop(sid: string): Promise<'stopped' | 'not-found'> {
      const res = await transport.request(`/hlsv2/${sidPath(sid)}/prepare`, {
        method: 'DELETE',
        timeoutMs: timeouts.control,
      });
      if (res.status === 204 || res.status === 200) {
        await discard(res);
        return 'stopped';
      }
      if (res.status === 404) {
        await discard(res);
        return 'not-found';
      }
      throw await unexpected(res, 'prepare-stop');
    },

    resetCapabilities() {
      deleteSupport = undefined;
      prepareSupport = undefined;
      openSubHashSupported = true;
    },

    torrentMediaURL(infoHash: string, fileIdx: number, trackers: readonly string[] = []): string {
      const base = `${selfBase}/${checkInfoHash(infoHash)}/${String(checkFileIdx(fileIdx))}`;
      const query = new URLSearchParams(trackers.map((tr) => ['tr', tr])).toString();
      return query === '' ? base : `${base}?${query}`;
    },

    youtubeMediaURL(ytId: string): string {
      return `${selfBase}/yt/${encodeURIComponent(ytId)}`;
    },

    proxyStreamMediaURL(request: ProxyStreamRequest): string {
      const parts = [`d=${Buffer.from(request.url, 'utf8').toString('base64url')}`];
      for (const [name, value] of Object.entries(request.requestHeaders ?? {})) {
        parts.push(`h_${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
      }
      for (const [name, value] of Object.entries(request.responseHeaders ?? {})) {
        parts.push(`r_${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
      }
      return client.withApiPassword(
        `${selfBase}/proxy/stream?${parts.join('&')}`,
        request.apiPassword,
      );
    },

    proxyHlsMediaURL(request: ProxyStreamRequest): string {
      const parts = [`d=${Buffer.from(request.url, 'utf8').toString('base64url')}`];
      for (const [name, value] of Object.entries(request.requestHeaders ?? {})) {
        parts.push(`h_${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
      }
      for (const [name, value] of Object.entries(request.responseHeaders ?? {})) {
        parts.push(`r_${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
      }
      return `${selfBase}/proxy/hls/manifest.m3u8?${parts.join('&')}`;
    },

    liveFetch(request: LiveFetchRequest): Promise<Response> {
      const parts = [`d=${Buffer.from(request.dest, 'utf8').toString('base64url')}`];
      // Only the header parameters carry over: the engine applies them to every child.
      for (const [name, value] of new URL(request.source).searchParams) {
        if (/^[hr]_/.test(name)) {
          parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
        }
      }
      if (request.apiPassword !== undefined && request.apiPassword !== '') {
        parts.push(`api_password=${encodeURIComponent(request.apiPassword)}`);
      }
      return transport.request(`${request.endpoint}?${parts.join('&')}`, {
        timeoutMs: timeouts.media,
        signal: request.signal,
        ...(request.range === undefined ? {} : { headers: { Range: request.range } }),
      });
    },

    withApiPassword(mediaURL: string, apiPassword: string | undefined): string {
      if (apiPassword === undefined || apiPassword === '') return mediaURL;
      if (!mediaURL.startsWith(`${selfBase}/proxy/stream?`)) return mediaURL;
      return `${mediaURL}&api_password=${encodeURIComponent(apiPassword)}`;
    },

    async openSubHash(mediaURL: string, signal?: AbortSignal): Promise<OpenSubHash | undefined> {
      if (!openSubHashSupported) return undefined;
      const res = await transport.request(`/opensubHash?videoUrl=${encodeURIComponent(mediaURL)}`, {
        timeoutMs: timeouts.prepare,
        signal,
      });
      if (res.status === 405) {
        await discard(res);
        openSubHashSupported = false;
        return undefined;
      }
      if (res.status === 404) {
        // An engine without the endpoint routes it to Go's generic 404 (as for
        // the DELETE probe, the route's own answers differ); any other 404 is
        // about this file and turns nothing off.
        if (isRouteNotFound(await readBodyText(res))) openSubHashSupported = false;
        return undefined;
      }
      if (res.status !== 200) throw await unexpected(res, 'opensubHash');
      const parsed = OpenSubHashSchema.safeParse(await readJson(res, 'opensubHash'));
      if (!parsed.success) {
        throw new ServerGoError('opensubHash', 'unexpected hash shape', res.status);
      }
      return { hash: parsed.data.result.hash, size: parsed.data.result.size };
    },

    async metrics(): Promise<string> {
      const res = await transport.request('/metrics', { timeoutMs: timeouts.control });
      if (res.status !== 200) throw await unexpected(res, 'metrics');
      return res.text();
    },
  };
  return client;
}
