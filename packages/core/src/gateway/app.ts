import { Hono, type Context } from 'hono';
import type { Config } from '../config.ts';
import { EngineSessionNotFoundError } from '../engines/engine-module.ts';
import { LIVE_FILE } from '../engines/live.ts';
import type { EngineModule } from '../engines/module.ts';
import { EngineTransportError } from '../engines/transport.ts';
import { allowlistCors } from '../http/cors.ts';
import { notFoundResponse } from '../http/problem.ts';
import type { Logger } from '../log.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { SessionService } from '../sessions/service.ts';
import { SubtitleFileError } from '../subtitles/index.ts';
import type { GatewayServices } from './services.ts';

/** What the media listener serves from: sessions, the engine module and the gateway services. */
export interface MediaServices {
  sessions: Pick<SessionService, 'mediaTarget' | 'touch'>;
  engines: Pick<EngineModule, 'fetchMedia'>;
  gateway: GatewayServices;
  metrics?: Pick<MetricsRegistry, 'recordGatewayRequest' | 'recordGatewayBytes'> | undefined;
}

/**
 * What the media listener needs. Without `services` (an app built only to
 * check CORS) every `/media` path answers `404`.
 */
export interface MediaAppDeps {
  config: Config;
  logger: Logger;
  services?: MediaServices | undefined;
}

/** The only path prefix the media listener serves (okf:architecture/media-gateway). */
export const MEDIA_PREFIX = '/media';

/** Methods a media request may use; the preflight answer for `/media/…`. */
const MEDIA_METHODS = ['GET', 'HEAD'] as const;

/** A single byte range, as a player sends it for an `EXT-X-BYTERANGE` segment. */
const BYTE_RANGE = /^bytes=\d{0,15}-\d{0,15}$/;

/**
 * The engine files a token may reach (okf:architecture/media-gateway): the master, media playlists,
 * segments and subtitle renditions. Anything else is `404`, so no engine API
 * is reachable through the gateway.
 */
const ENGINE_FILE =
  /^(?:master\.m3u8|(?:playlist|video|audio\d{1,4}|sub\d{1,4})\.m3u8|(?:a\d{1,4})?seg\d{1,7}\.ts|sub\d{1,4}\.vtt)$/;
/** An addon subtitle for the session's item (okf:architecture/core-subtitles-and-player-state). */
const EXT_SUBTITLE = /^ext\/sub\/([A-Za-z0-9_-]{32})\.vtt$/;
/** `/media/{token}/{rest}`; the token is a compact JWS. */
const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/;

type FileKind = 'playlist' | 'segment' | 'subtitle';

const kindOf = (file: string): FileKind =>
  file.endsWith('.ts') ? 'segment' : file.endsWith('.vtt') ? 'subtitle' : 'playlist';

const DEFAULT_TYPES: Record<FileKind, string> = {
  playlist: 'application/vnd.apple.mpegurl',
  segment: 'video/mp2t',
  subtitle: 'text/vtt; charset=utf-8',
};

/** Sent with every media response (okf:architecture/media-gateway-proxy, okf:architecture/secrets-policy). */
const MEDIA_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** Reads `body` to its end and drops it; never throws. */
async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    // The engine went away; nothing to keep.
  } finally {
    reader.releaseLock();
  }
}

/**
 * Passes `upstream` through unbuffered, counting the bytes handed on. When the
 * viewer goes away: with `detach`, the upstream is still read to its end (a
 * segment transcode other viewers may wait for must finish, okf:architecture/media-gateway-proxy); otherwise
 * it is cancelled.
 */
function passThrough(
  upstream: ReadableStream<Uint8Array>,
  options: {
    detach: boolean;
    onBytes: (count: number) => void;
    onDetached: (p: Promise<void>) => void;
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          options.onBytes(value.byteLength);
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        if (!options.detach) return reader.cancel(reason).catch(() => undefined);
        reader.releaseLock();
        options.onDetached(drain(upstream));
        return undefined;
      },
    },
    { highWaterMark: 0 },
  );
}

const KNOWN_GOOD_MAX = 10_000;

/**
 * Sessions that have served at least one segment since the media app started
 * (bounded: forgotten wholesale past {@link KNOWN_GOOD_MAX}). Their segment
 * `404`s get one retry, as `502`/`504` from the engine do for any session (okf:architecture/media-gateway).
 */
class KnownGood {
  readonly #ids = new Set<string>();
  has(id: string): boolean {
    return this.#ids.has(id);
  }
  add(id: string): void {
    if (this.#ids.size >= KNOWN_GOOD_MAX) this.#ids.clear();
    this.#ids.add(id);
  }
}

/**
 * The media listener's app (`MULTITAP_MEDIA_PORT`, okf:architecture/media-gateway). It serves only
 * `/media/{token}/…`; every other path is a `404`, so nothing else on Multitap or
 * an engine is reachable through it.
 *
 * CORS (okf:architecture/media-gateway-proxy) applies to `/media/*` only: for an origin in `MULTITAP_CORS_ORIGINS`,
 * `Access-Control-Allow-Origin`, `Vary: Origin`, exposed `Content-Length` and
 * `Content-Range`, and preflights for `GET`/`HEAD` with `Range`. Handlers that
 * pass an upstream response through return a new `Response`, so these headers
 * merge into it.
 *
 * A request: the filename allowlist, then the token (signature with HS256
 * pinned, `exp`, then released, epoch and subject denylist in memory), then
 * the engine through `EngineModule.fetchMedia` (the master always self-heals).
 * `401` expired, `410` released, `404` for everything else that can't be
 * served. `Range` is ignored (the whole file, `200`); `HEAD` gets the headers.
 *
 * A live session (okf:architecture/media-gateway "Live") also serves `live/{sealed}.{ext}`:
 * the children of its proxied playlists. Those are passed through from the
 * engine's HLS proxy, a single `Range` included (`206`), are cancelled when
 * the viewer leaves (nothing is transcoded), and don't count as engine load.
 *
 * Logging at `info` names the session id and subject, never the path or the
 * token (okf:architecture/secrets-policy); the path is logged at `debug` only.
 */
export function createMediaApp(deps: MediaAppDeps): Hono {
  const app = new Hono();
  const { logger } = deps;
  /** Segment reads that outlived their viewer; awaited by nothing, but kept reachable. */
  const detached = new Set<Promise<void>>();

  app.use(
    `${MEDIA_PREFIX}/*`,
    allowlistCors(deps.config.corsOrigins, {
      allowMethods: () => MEDIA_METHODS,
      allowHeaders: ['Range'],
      exposeHeaders: ['Content-Length', 'Content-Range'],
    }),
  );

  const services = deps.services;
  if (services === undefined) {
    app.on([...MEDIA_METHODS], `${MEDIA_PREFIX}/:token/*`, (c) => notFoundResponse(c));
  } else {
    const servedSegments = new KnownGood();
    app.on([...MEDIA_METHODS], `${MEDIA_PREFIX}/:token/*`, (c) =>
      serveMedia(c, services, logger, servedSegments, (p) => {
        detached.add(p);
        void p.finally(() => detached.delete(p));
      }),
    );
  }

  app.notFound((c) => notFoundResponse(c));
  app.onError((err, c) => {
    logger.error({ err }, 'unhandled media error');
    return c.body(null, 500, { ...MEDIA_HEADERS });
  });
  return app;
}

async function serveMedia(
  c: Context,
  services: MediaServices,
  logger: Logger,
  servedSegments: KnownGood,
  onDetached: (p: Promise<void>) => void,
): Promise<Response> {
  const start = performance.now();
  const { gateway, metrics } = services;
  const path = new URL(c.req.url).pathname;
  logger.debug({ method: c.req.method, path }, 'media request');

  /** What the log line names: never the path or the token (okf:architecture/secrets-policy). */
  const who: { sessionId?: string; subject?: string; kind?: FileKind } = {};
  const done = (res: Response, reason?: string): Response => {
    metrics?.recordGatewayRequest(res.status);
    logger.info(
      {
        ...who,
        method: c.req.method,
        status: res.status,
        reason,
        durationMs: Math.round((performance.now() - start) * 10) / 10,
      },
      'media',
    );
    return res;
  };
  const empty = (status: 400 | 401 | 410 | 502 | 504, reason: string) =>
    done(c.body(null, status, { ...MEDIA_HEADERS }), reason);

  const match = MEDIA_PATH.exec(path);
  const token = match?.[1];
  const file = match?.[2];
  if (token === undefined || file === undefined) return done(notFoundResponse(c), 'bad-path');
  const subtitle = EXT_SUBTITLE.exec(file);
  const liveFile = subtitle === null && LIVE_FILE.test(file);
  if (subtitle === null && !liveFile && !ENGINE_FILE.test(file)) {
    return done(notFoundResponse(c), 'not-allowed');
  }
  const kind: FileKind = liveFile && !file.endsWith('.m3u8') ? 'segment' : kindOf(file);
  who.kind = kind;

  // `?offsetMs=` shifts an addon subtitle (okf:architecture/core-subtitles-and-player-state); the query isn't part of the allowlisted path.
  let requestOffsetMs = 0;
  const offsetParam = subtitle === null ? null : new URL(c.req.url).searchParams.get('offsetMs');
  if (offsetParam !== null) {
    if (!/^-?\d{1,9}$/.test(offsetParam)) return empty(400, 'bad-offset');
    requestOffsetMs = Number(offsetParam);
  }

  const verified = await gateway.tokens.verify(token);
  if (!verified.ok) {
    if (verified.reason === 'expired') return empty(401, verified.reason);
    if (verified.reason === 'released') return empty(410, verified.reason);
    return done(notFoundResponse(c), verified.reason);
  }
  const { sessionId: sid, subject: sub } = verified.claims;
  who.sessionId = sid;
  who.subject = sub;

  const target = await services.sessions.mediaTarget(sid);
  if (target.kind === 'released') return empty(410, 'released');
  if (target.kind === 'not-found') return done(notFoundResponse(c), 'unknown-session');
  // A live session's files are proxied, not transcoded: no engine load.
  const live = target.session.live;
  void services.sessions.touch(sid, kind === 'segment' && !live ? 'segment' : 'read');
  // A sealed live name says nothing and never repeats: telemetry gets its kind.
  const seen = subtitle !== null ? 'ext/sub' : liveFile ? `live/${kind}` : file;
  gateway.viewers.request(sid, sub, seen);
  const head = c.req.method === 'HEAD';
  const count = (n: number) => {
    gateway.viewers.bytes(sid, sub, n);
    metrics?.recordGatewayBytes(kind, n);
  };

  // An addon subtitle of the session's own item.
  if (subtitle !== null) {
    let vtt: string;
    try {
      vtt = await gateway.subtitles.file(target.session, subtitle[1] ?? '', requestOffsetMs);
    } catch (err) {
      if (err instanceof SubtitleFileError) {
        return err.code === 'not-found'
          ? done(notFoundResponse(c), 'subtitle-not-found')
          : empty(502, `subtitle-${err.code}`);
      }
      throw err;
    }
    const bytes = new TextEncoder().encode(vtt);
    if (!head) count(bytes.byteLength);
    return done(
      new Response(head ? null : bytes, {
        status: 200,
        headers: {
          ...MEDIA_HEADERS,
          'Content-Type': DEFAULT_TYPES.subtitle,
          'Content-Length': String(bytes.byteLength),
        },
      }),
    );
  }

  if (target.kind === 'not-ready') return done(notFoundResponse(c), 'not-ready');
  if (liveFile && !live) return done(notFoundResponse(c), 'not-live');

  // Segments ignore the viewer's disconnect (okf:architecture/media-gateway-proxy): the engine kills a
  // transcode whose request goes away, and other viewers may be waiting on it.
  // A live session's are only proxied, so they end with their viewer.
  const segment = kind === 'segment';
  const detach = segment && !live;
  const viewerSignal = c.req.raw.signal;
  const rangeHeader = live && segment ? c.req.header('range') : undefined;
  const range = rangeHeader !== undefined && BYTE_RANGE.test(rangeHeader) ? rangeHeader : undefined;
  const fetchFile = (signal: AbortSignal | undefined) =>
    range === undefined
      ? services.engines.fetchMedia(target.handle, file, signal)
      : services.engines.fetchMedia(target.handle, file, signal, { range });
  let upstream: Response;
  try {
    upstream = await fetchFile(detach ? undefined : viewerSignal);
    // A source that failed mid-stream (e.g. the origin's 429) may be temporary:
    // retry the segment once. An engine with #53 says so with a 502 or 504; an
    // older one answers 404, which can't be told apart from a missing segment
    // (okf:process/upstream-engine-asks), so a 404 is retried only for a session that has served segments.
    const status = upstream.status;
    const retry =
      status === 502 || status === 504 || (status === 404 && !live && servedSegments.has(sid));
    if (segment && retry && !viewerSignal.aborted) {
      await upstream.body?.cancel().catch(() => undefined);
      logger.info(
        { ...who, method: c.req.method, status },
        'engine error on a segment; retrying once',
      );
      upstream = await fetchFile(detach ? undefined : viewerSignal);
    }
  } catch (err) {
    if (err instanceof EngineSessionNotFoundError)
      return done(notFoundResponse(c), 'no-engine-session');
    if (err instanceof EngineTransportError) {
      if (err.code === 'aborted') return empty(502, 'viewer-gone');
      return empty(err.code === 'timeout' ? 504 : 502, `engine-${err.code}`);
    }
    throw err;
  }
  if (segment && upstream.ok) servedSegments.add(sid);

  if (!upstream.ok || upstream.body === null) {
    // Engine error texts can name the engine session; send none of it.
    if (upstream.body !== null) {
      if (detach) onDetached(drain(upstream.body));
      else void upstream.body.cancel().catch(() => undefined);
    }
    // 404: evicted, or past the end; the player reloads the master (okf:architecture/engine-session-lifecycle).
    return upstream.status === 404
      ? done(notFoundResponse(c), 'engine-404')
      : upstream.ok
        ? empty(502, 'engine-empty')
        : empty(502, `engine-${String(upstream.status)}`);
  }

  const headers: Record<string, string> = {
    ...MEDIA_HEADERS,
    'Content-Type': upstream.headers.get('content-type') ?? DEFAULT_TYPES[kind],
  };
  const length = upstream.headers.get('content-length');
  if (length !== null) headers['Content-Length'] = length;
  // A range the engine's proxy honoured for a live segment.
  const contentRange = upstream.status === 206 ? upstream.headers.get('content-range') : null;
  if (contentRange !== null) headers['Content-Range'] = contentRange;

  if (head || (detach && viewerSignal.aborted)) {
    // Nobody reads the body: a transcoded segment still runs to its end, anything else stops.
    if (detach) onDetached(drain(upstream.body));
    else void upstream.body.cancel().catch(() => undefined);
    return done(new Response(null, { status: upstream.status, headers }));
  }

  const body = passThrough(upstream.body, { detach, onBytes: count, onDetached });
  return done(new Response(body, { status: upstream.status, headers }));
}
