import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parsePrivateAllow } from '@multitap/addon-protocol';
import { z } from 'zod';
import { MULTITAP_VERSION } from './version.ts';

/**
 * Multitap's configuration, read once from the environment at startup (see
 * okf:architecture/configuration). Environment variables hold operational limits; preferences that
 * change while Multitap runs (ranking, engines, addons) live in the database.
 */
export interface Config {
  apiPort: number;
  /** Address the API listener binds to (`MULTITAP_API_BIND`); `null` = all interfaces, Node's default. */
  apiBind: string | null;
  /** Absolute path of the directory holding Multitap's SQLite database. */
  dataDir: string;
  logLevel: LogLevel;
  /** Optional JSON log files (`MULTITAP_LOG_DIR`), in addition to or instead of stdout. */
  logging: {
    /** Absolute directory for rotated log files; `null` (unset) = stdout only. */
    dir: string | null;
    /** Whether logs also go to stdout (`MULTITAP_LOG_STDOUT`, default true). */
    stdout: boolean;
    /** Rotated files kept besides the current one (default 7). */
    fileKeep: number;
    /** A file rotates when it reaches this many bytes (default 50 MiB), and daily. */
    fileMaxSizeBytes: number;
  };
  nodeEnv: NodeEnv;
  /** Database backups through `/v1/admin/backups` (okf:architecture/core-persistence). */
  backup: {
    /** Absolute directory holding the backups (default `<dataDir>/backups`). */
    dir: string;
    /** Scheduled backups every this many ms; `0` = off (default). */
    intervalMs: number;
    /** Backups kept, scheduled and manual alike; the oldest are pruned (default 7). */
    keep: number;
  };
  /** The media listener and media tokens (okf:concept/media-tokens, okf:architecture/media-gateway). */
  media: {
    /** Port of the `/media` listener (default 8081). Tests may set `0` in a Config object for a free one. */
    port: number;
    /** Address the media listener binds to (`MULTITAP_MEDIA_BIND`); `null` = all interfaces. */
    bind: string | null;
    /**
     * HS256 signing key for media tokens (`MULTITAP_MEDIA_TOKEN_SECRET` or the file
     * named by `MULTITAP_MEDIA_TOKEN_SECRET_FILE`), at least 32 bytes. `null` when
     * unset: Multitap then signs with a random per-process key and warns, so
     * tokens don't survive a restart.
     */
    tokenSecret: string | null;
    /** A previous secret still accepted for verification while rotating (okf:concept/media-tokens). Never used to sign. */
    previousTokenSecret: string | null;
    /** Default token lifetime in milliseconds (default 8 h). */
    tokenTtlMs: number;
    /** Longest lifetime a mint request may ask for, in milliseconds (default 7 days). */
    tokenMaxTtlMs: number;
    /**
     * Absolute base for `mediaUrl` (`https://media.example.org`), without a
     * trailing slash. Required when the media listener is public; `null` = token
     * responses carry only `mediaPath`.
     */
    publicBase: string | null;
  };
  /** Exact browser origins allowed on both listeners (okf:architecture/core-deployment, okf:architecture/media-gateway-proxy). Empty = no CORS headers. */
  corsOrigins: string[];
  /** Built-in TLS on both listeners (okf:architecture/configuration), or `null` for plain HTTP. Paths are absolute. */
  tls: { certFile: string; keyFile: string } | null;
  /** Playback sessions (okf:architecture/playback-session, okf:architecture/rendition-and-bandwidth, okf:architecture/engine-retention). */
  sessions: {
    /** Ceiling for a session's `quality.bitrate`, bits per second (default 20 M). */
    maxBitrate: number;
    /**
     * `MULTITAP_SESSION_BITRATE_BY_HEIGHT`: the bitrate Multitap derives for a request with
     * `maxHeight` but no `bitrate` (okf:architecture/rendition-and-bandwidth), ascending by height. Empty (`off`) =
     * derive nothing, so the engine's own bitrate applies.
     */
    bitrateByHeight: BitrateRung[];
    /** `retention.idle`: a session lives until max(retainUntil, lastAccess + this). Default 1 h. */
    retentionIdleMs: number;
    /** How long a released session is kept so its media answers `410` (default 24 h). */
    releasedKeepMs: number;
    /** How often retention is swept (default 1 min). */
    sweepIntervalMs: number;
  };
  selection: {
    /** Used when a request doesn't set `highRes` (okf:concept/source-ranking). */
    defaultHighRes: HighResPolicy;
    /** Engine used when a request names none; unset means the only engine there is (okf:decision/auto-select-and-fallback). */
    defaultEngine: string | undefined;
    /** ISO 639-2/B audio language ranking prefers (okf:concept/source-ranking rule 6). */
    preferredLanguage: string;
    /** How long a source list's candidate keys stay valid (default 6 h); older keys get `409`. */
    streamStoreTtlMs: number;
    /** Auto-select: failed candidates before giving up (okf:decision/auto-select-and-fallback, default 5). */
    autoMaxAttempts: number;
    /** Auto-select: wait before retrying a failed torrent once (the engine's negative-probe window, default 30 s). */
    autoRetryAfterMs: number;
    /**
     * Auto-select: how long one candidate may take to become ready before Multitap
     * abandons it and tries the next (default 45 s). Null (`0`) = no limit
     * beyond the engine timeouts. A picked source never has one.
     */
    autoAttemptTimeoutMs: number | null;
  };
  addons: {
    /** Per-request addon timeouts in milliseconds (okf:concept/addon-aggregation). */
    timeoutsMs: { catalog: number; meta: number; streams: number; subtitles: number };
    /** Manifest fetch timeout in milliseconds (default 10 s). */
    manifestTimeoutMs: number;
    /** How often cached manifests are refetched, in milliseconds (default 6 h). */
    manifestRefreshMs: number;
    /** Most addon responses kept in the in-memory response cache. */
    responseCacheEntries: number;
    /** Consecutive failures that open an addon's circuit (default 5). */
    circuitFailures: number;
    /** How long an open circuit refuses requests, in milliseconds (default 60 s). */
    circuitResetMs: number;
    /** The `User-Agent` of addon requests (`MULTITAP_ADDON_USER_AGENT`, default `Multitap/<version> (+https://multitap.dev)`). */
    userAgent: string;
    /**
     * Manifest URLs installed once, on first start, when the addon table is
     * empty (`MULTITAP_DEFAULT_ADDONS`, comma-separated; default none). Secret, like any
     * manifest URL.
     */
    defaultManifestUrls: string[];
    /**
     * Private hosts addons may point Multitap at (`MULTITAP_ADDON_PRIVATE_ALLOW`: IPs,
     * CIDRs and host names, comma-separated; default none): redirects of addon
     * requests and subtitle files (okf:architecture/addon-private-host-guard).
     */
    privateAllow: string[];
  };
  /** Fetching addon subtitle files. */
  subtitles: {
    /** Default 10 s. */
    timeoutMs: number;
    /** Default 5 MiB. */
    maxBytes: number;
  };
  /** Engine transport and health checks (okf:architecture/engine-endpoints-core-uses, okf:architecture/engine-transport-and-health). */
  engines: {
    /** Time between health checks of an online engine (default 30 s). */
    healthIntervalMs: number;
    /** Timeout of one health check (default 5 s). */
    healthTimeoutMs: number;
    /** Longest backoff between checks of an offline engine (default 60 s). */
    healthMaxBackoffMs: number;
    /**
     * Connect timeout (TCP and TLS handshake) of `lan` engine requests
     * (default 3 s): a stopped engine host that drops connections fails fast
     * instead of after undici's 10 s.
     */
    connectTimeoutMs: number;
    /**
     * Per-session engine TTL (#25, okf:architecture/engine-retention), sent to engines with
     * `sessionOverrides` as a safety net for sessions Multitap fails to delete.
     * Null (the default) sends none, so the engine's own TTL applies.
     */
    sessionTtlMs: number | null;
    /**
     * What a new session does when its engine already runs `liveConcurrency`
     * sessions (okf:architecture/engine-session-lifecycle): `off` nothing, `warn` (default) a warning, `reject` a
     * `503` with `Retry-After`.
     */
    admission: EngineAdmission;
    /** A ready session counts toward its engine's load while it had a segment request this recently (default 60 s). */
    loadWindowMs: number;
    timeoutsMs: {
      /** stats, delete, metrics, capability probes (default 10 s). */
      control: number;
      /** Torrent create (metadata wait), probe, and the creating master request (default 150 s). */
      prepare: number;
      /**
       * Playlists and segments through the gateway (default 200 s). Never
       * shorter than the engine's `STREMIO_HLS_SEGMENT_TIMEOUT` (okf:architecture/media-gateway-proxy).
       */
      media: number;
    };
  };
  /** `/v1/events` (okf:architecture/core-events-sse). */
  events: {
    /** Events kept for `Last-Event-ID` replay (default 1000). */
    replaySize: number;
    /** Heartbeat comment interval (default 15 s). */
    heartbeatMs: number;
  };
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'production', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const HIGH_RES_POLICIES = ['off', 'prepareOnly', 'on'] as const;
export type HighResPolicy = (typeof HIGH_RES_POLICIES)[number];

export const ENGINE_ADMISSIONS = ['off', 'warn', 'reject'] as const;
export type EngineAdmission = (typeof ENGINE_ADMISSIONS)[number];

/** One rung of `MULTITAP_SESSION_BITRATE_BY_HEIGHT`: output heights up to `height` get `bitrate`. */
export interface BitrateRung {
  /** Pixels. */
  height: number;
  /** Bits per second. */
  bitrate: number;
}

/**
 * The default `MULTITAP_SESSION_BITRATE_BY_HEIGHT` (okf:architecture/rendition-and-bandwidth): H.264 bitrates for a fast
 * hardware preset, a little above the usual streaming ladders (Apple's HLS
 * authoring ladder, for one) because QSV `veryfast` is less efficient than
 * libx264. Every live rung (up to 1080p) stays below server-go's own default
 * of 8M, so a derived bitrate never raises what the engine would use.
 */
export const DEFAULT_BITRATE_BY_HEIGHT: readonly BitrateRung[] = [
  { height: 240, bitrate: 600_000 },
  { height: 360, bitrate: 1_000_000 },
  { height: 480, bitrate: 1_500_000 },
  { height: 576, bitrate: 2_000_000 },
  { height: 720, bitrate: 3_000_000 },
  { height: 1080, bitrate: 6_000_000 },
  { height: 1440, bitrate: 10_000_000 },
  { height: 2160, bitrate: 16_000_000 },
];

/** Media token secrets must be at least this many bytes (UTF-8). */
export const MIN_TOKEN_SECRET_BYTES = 32;

/** `quality.bitrate` and `MULTITAP_SESSION_MAX_BITRATE` floor, as #25 accepts (100k). */
export const MIN_SESSION_BITRATE = 100_000;
/** #25's ceiling for a per-session bitrate (200M). */
export const MAX_SESSION_BITRATE = 200_000_000;

// Unset and empty variables both mean "use the default", so `MULTITAP_API_PORT=` in a
// compose file doesn't turn into port 0.
const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const port = z.coerce.number().int().min(1).max(65535);
const timeoutMs = z.coerce.number().int().min(100).max(300_000);
const durationMs = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const count = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** `20M`, `1.5M`, `800k` or a plain integer, in bits per second (ffmpeg's decimal suffixes). */
const bitrate = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?[kKmM]?$/, 'Expected bits per second, e.g. 20M, 1.5M, 800k or 20000000')
  .transform((value) => {
    const suffix = value.at(-1)?.toLowerCase();
    const factor = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1;
    const digits = factor === 1 ? value : value.slice(0, -1);
    return Math.round(Number(digits) * factor);
  })
  .pipe(z.number().int().min(MIN_SESSION_BITRATE).max(MAX_SESSION_BITRATE));

/** `240=600k,360=1M,…` (height=bitrate, comma-separated) or `off`. */
const bitrateByHeight = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.toLowerCase() === 'off') return [];
    const rungs: BitrateRung[] = [];
    for (const part of value.split(',')) {
      const match = /^\s*(\d+)\s*=\s*(\S+)\s*$/.exec(part);
      const height = Number(match?.[1]);
      const rate = bitrate.safeParse(match?.[2] ?? '');
      if (match === null || !Number.isInteger(height) || height < 144 || height > 4320) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected height=bitrate pairs such as 720=3M (height 144–4320), or off; bad entry "${part.trim()}"`,
        });
        return z.NEVER;
      }
      if (!rate.success) {
        ctx.addIssue({
          code: 'custom',
          message: `Bitrate for ${String(height)} must be 100k–200M, e.g. 3M or 800k`,
        });
        return z.NEVER;
      }
      rungs.push({ height, bitrate: rate.data });
    }
    rungs.sort((a, b) => a.height - b.height);
    for (const [i, rung] of rungs.entries()) {
      const prev = rungs[i - 1];
      if (prev === undefined) continue;
      if (rung.height === prev.height) {
        ctx.addIssue({ code: 'custom', message: `Height ${String(rung.height)} is listed twice` });
        return z.NEVER;
      }
      if (rung.bitrate < prev.bitrate) {
        ctx.addIssue({
          code: 'custom',
          message: `Bitrates must not fall as height rises (${String(prev.height)} → ${String(rung.height)})`,
        });
        return z.NEVER;
      }
    }
    return rungs;
  });

/** A listener address: an IPv4 or IPv6 address, or a host name. */
const bindAddress = z
  .string()
  .trim()
  .refine(
    (value) =>
      isIP(value) !== 0 ||
      (value.length <= 253 &&
        /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
          value,
        )),
    'Expected an IP address (0.0.0.0, 127.0.0.1, ::, 192.168.1.10) or a host name',
  );

/** An exact browser origin: scheme, host and optional port, nothing else. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const corsOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(
    z.array(
      z
        .string()
        .refine(
          isOrigin,
          'Expected exact origins such as https://app.example.org (no path, no trailing slash), comma-separated',
        ),
    ),
  );

const publicBase = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.search === '' &&
        url.hash === '' &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'Expected an absolute http(s) URL without query or fragment, e.g. https://media.example.org')
  .transform((value) => value.replace(/\/+$/, ''));

/** `50M`, `512k`, `1G` or a plain integer, in bytes (binary multiples). */
const byteSize = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?[kKmMgG]?$/, 'Expected a size such as 50M, 512k, 1G or a byte count')
  .transform((value) => {
    const suffix = value.at(-1)?.toLowerCase();
    const factor =
      suffix === 'k' ? 1024 : suffix === 'm' ? 1024 ** 2 : suffix === 'g' ? 1024 ** 3 : 1;
    const digits = /\d$/.test(value) ? value : value.slice(0, -1);
    return Math.round(Number(digits) * factor);
  })
  .pipe(
    z
      .number()
      .int()
      .min(1024 ** 2)
      .max(10 * 1024 ** 3),
  );

const booleanFlag = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const v = value.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: 'Expected true or false' });
    return z.NEVER;
  });

const secret = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') >= MIN_TOKEN_SECRET_BYTES,
    `Must be at least ${String(MIN_TOKEN_SECRET_BYTES)} bytes`,
  );

const EnvSchema = z.object({
  MULTITAP_API_PORT: z.preprocess(blankAsUnset, port.default(8080)),
  MULTITAP_MEDIA_PORT: z.preprocess(blankAsUnset, port.default(8081)),
  MULTITAP_API_BIND: z.preprocess(blankAsUnset, bindAddress.optional()),
  MULTITAP_MEDIA_BIND: z.preprocess(blankAsUnset, bindAddress.optional()),
  MULTITAP_DATA_DIR: z.preprocess(blankAsUnset, z.string().default('./data')),
  MULTITAP_LOG_LEVEL: z.preprocess(blankAsUnset, z.enum(LOG_LEVELS).default('info')),
  MULTITAP_LOG_DIR: z.preprocess(blankAsUnset, z.string().optional()),
  MULTITAP_LOG_STDOUT: z.preprocess(blankAsUnset, booleanFlag.default(true)),
  MULTITAP_LOG_FILE_KEEP: z.preprocess(blankAsUnset, count(1, 3650).default(7)),
  MULTITAP_LOG_FILE_MAX_SIZE: z.preprocess(blankAsUnset, byteSize.default(50 * 1024 ** 2)),
  MULTITAP_BACKUP_DIR: z.preprocess(blankAsUnset, z.string().optional()),
  // 0 = no scheduled backups; otherwise at least a minute.
  MULTITAP_BACKUP_INTERVAL_MS: z.preprocess(
    blankAsUnset,
    durationMs(0, 365 * DAY)
      .refine((v) => v === 0 || v >= 60_000, 'Must be 0 (off) or at least 60000')
      .default(0),
  ),
  MULTITAP_BACKUP_KEEP: z.preprocess(blankAsUnset, count(1, 1_000).default(7)),
  NODE_ENV: z.preprocess(blankAsUnset, z.enum(NODE_ENVS).default('production')),
  MULTITAP_MEDIA_TOKEN_SECRET: z.preprocess(blankAsUnset, secret.optional()),
  MULTITAP_MEDIA_TOKEN_SECRET_FILE: z.preprocess(blankAsUnset, z.string().optional()),
  MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS: z.preprocess(blankAsUnset, secret.optional()),
  MULTITAP_MEDIA_TOKEN_TTL_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 7 * DAY).default(8 * HOUR),
  ),
  MULTITAP_MEDIA_TOKEN_MAX_TTL_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 30 * DAY).default(7 * DAY),
  ),
  MULTITAP_MEDIA_PUBLIC_BASE: z.preprocess(blankAsUnset, publicBase.optional()),
  MULTITAP_CORS_ORIGINS: z.preprocess(blankAsUnset, corsOrigins.default([])),
  MULTITAP_TLS_CERT_FILE: z.preprocess(blankAsUnset, z.string().optional()),
  MULTITAP_TLS_KEY_FILE: z.preprocess(blankAsUnset, z.string().optional()),
  MULTITAP_SESSION_MAX_BITRATE: z.preprocess(blankAsUnset, bitrate.default(20_000_000)),
  MULTITAP_SESSION_BITRATE_BY_HEIGHT: z.preprocess(blankAsUnset, bitrateByHeight.optional()),
  MULTITAP_RETENTION_IDLE_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 30 * DAY).default(HOUR),
  ),
  MULTITAP_SESSION_RELEASED_KEEP_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 30 * DAY).default(DAY),
  ),
  MULTITAP_RETENTION_SWEEP_MS: z.preprocess(blankAsUnset, durationMs(1_000, HOUR).default(60_000)),
  MULTITAP_SELECTION_DEFAULT_HIGH_RES: z.preprocess(
    blankAsUnset,
    z.enum(HIGH_RES_POLICIES).default('off'),
  ),
  MULTITAP_SELECTION_DEFAULT_ENGINE: z.preprocess(
    blankAsUnset,
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Expected an engine id')
      .optional(),
  ),
  MULTITAP_SELECTION_PREFERRED_LANGUAGE: z.preprocess(
    blankAsUnset,
    z
      .string()
      .regex(/^[a-z]{3}$/, 'Expected an ISO 639-2/B code such as eng')
      .default('eng'),
  ),
  MULTITAP_STREAM_STORE_TTL_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 7 * DAY).default(6 * HOUR),
  ),
  MULTITAP_AUTO_SELECT_MAX_ATTEMPTS: z.preprocess(blankAsUnset, count(1, 50).default(5)),
  MULTITAP_AUTO_SELECT_RETRY_AFTER_MS: z.preprocess(
    blankAsUnset,
    durationMs(0, HOUR).default(30_000),
  ),
  // 0 = no limit; otherwise at least 5 s, so a healthy HTTP source always fits.
  MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS: z.preprocess(
    blankAsUnset,
    durationMs(0, HOUR)
      .refine((v) => v === 0 || v >= 5_000, 'Must be 0 (no limit) or at least 5000')
      .default(45_000),
  ),
  MULTITAP_ADDON_TIMEOUT_CATALOG_MS: z.preprocess(blankAsUnset, timeoutMs.default(5_000)),
  MULTITAP_ADDON_TIMEOUT_META_MS: z.preprocess(blankAsUnset, timeoutMs.default(5_000)),
  MULTITAP_ADDON_TIMEOUT_STREAMS_MS: z.preprocess(blankAsUnset, timeoutMs.default(10_000)),
  MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS: z.preprocess(blankAsUnset, timeoutMs.default(5_000)),
  MULTITAP_ADDON_TIMEOUT_MANIFEST_MS: z.preprocess(blankAsUnset, timeoutMs.default(10_000)),
  MULTITAP_ADDON_MANIFEST_REFRESH_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 7 * DAY).default(6 * HOUR),
  ),
  MULTITAP_ADDON_RESPONSE_CACHE_ENTRIES: z.preprocess(
    blankAsUnset,
    count(0, 100_000).default(1_000),
  ),
  MULTITAP_ADDON_CIRCUIT_FAILURES: z.preprocess(blankAsUnset, count(1, 1_000).default(5)),
  MULTITAP_ADDON_CIRCUIT_RESET_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, DAY).default(60_000),
  ),
  MULTITAP_ADDON_USER_AGENT: z.preprocess(
    blankAsUnset,
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => /^[ -~]+$/.test(v), 'Expected printable ASCII')
      .default(`Multitap/${MULTITAP_VERSION} (+https://multitap.dev)`),
  ),
  MULTITAP_DEFAULT_ADDONS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    ),
  MULTITAP_ADDON_PRIVATE_ALLOW: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .superRefine((entries, ctx) => {
      try {
        parsePrivateAllow(entries);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected IPs, CIDRs or host names, comma-separated (${(err as Error).message})`,
        });
      }
    }),
  MULTITAP_SUBTITLE_TIMEOUT_MS: z.preprocess(blankAsUnset, timeoutMs.default(10_000)),
  MULTITAP_SUBTITLE_MAX_BYTES: z.preprocess(
    blankAsUnset,
    count(1_024, 100 * 1024 * 1024).default(5 * 1024 * 1024),
  ),
  MULTITAP_ENGINE_HEALTH_INTERVAL_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, HOUR).default(30_000),
  ),
  MULTITAP_ENGINE_HEALTH_TIMEOUT_MS: z.preprocess(blankAsUnset, timeoutMs.default(5_000)),
  MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, DAY).default(60_000),
  ),
  MULTITAP_ENGINE_CONNECT_TIMEOUT_MS: z.preprocess(
    blankAsUnset,
    durationMs(100, 60_000).default(3_000),
  ),
  // #25 accepts 60 s to 30 d; whole seconds are sent.
  MULTITAP_ENGINE_SESSION_TTL_MS: z.preprocess(
    blankAsUnset,
    durationMs(60_000, 30 * DAY).optional(),
  ),
  MULTITAP_ENGINE_ADMISSION: z.preprocess(blankAsUnset, z.enum(ENGINE_ADMISSIONS).default('warn')),
  MULTITAP_ENGINE_LOAD_WINDOW_MS: z.preprocess(
    blankAsUnset,
    durationMs(5_000, HOUR).default(60_000),
  ),
  MULTITAP_ENGINE_TIMEOUT_CONTROL_MS: z.preprocess(blankAsUnset, timeoutMs.default(10_000)),
  MULTITAP_ENGINE_TIMEOUT_PREPARE_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, HOUR).default(150_000),
  ),
  MULTITAP_ENGINE_TIMEOUT_MEDIA_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, HOUR).default(200_000),
  ),
  MULTITAP_EVENTS_REPLAY_SIZE: z.preprocess(blankAsUnset, count(0, 100_000).default(1_000)),
  MULTITAP_EVENTS_HEARTBEAT_MS: z.preprocess(
    blankAsUnset,
    durationMs(1_000, 5 * 60_000).default(15_000),
  ),
});

/** Thrown by {@link loadConfig} with one line per invalid variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads a secret file, trimming a trailing newline (Docker secrets usually end with one). */
export type SecretFileReader = (path: string) => string;

const readSecretFile: SecretFileReader = (path) => readFileSync(path, 'utf8').replace(/\r?\n$/, '');

/**
 * Parses Multitap's settings from `env`. Unknown variables are ignored. Relative
 * paths resolve against `cwd`. `MULTITAP_MEDIA_TOKEN_SECRET_FILE` is read here, with
 * `readFile` (a test seam).
 *
 * @throws {ConfigError} when a variable is invalid.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  readFile: SecretFileReader = readSecretFile,
): Config {
  const result = EnvSchema.safeParse(env);
  const problems: string[] = [];
  const problem = (name: string, message: string) => {
    const value = env[name];
    // Secrets are never echoed back.
    const shown =
      value === undefined || name.includes('SECRET') ? '' : ` (got ${JSON.stringify(value)})`;
    problems.push(`  ${name}: ${message}${shown}`);
  };
  if (!result.success) {
    for (const issue of result.error.issues) problem(issue.path.join('.'), issue.message);
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const e = result.data;

  if (e.MULTITAP_API_PORT === e.MULTITAP_MEDIA_PORT) {
    problem('MULTITAP_MEDIA_PORT', 'Must differ from MULTITAP_API_PORT');
  }
  const ladder = e.MULTITAP_SESSION_BITRATE_BY_HEIGHT ?? [...DEFAULT_BITRATE_BY_HEIGHT];
  if ((e.MULTITAP_TLS_CERT_FILE === undefined) !== (e.MULTITAP_TLS_KEY_FILE === undefined)) {
    problem(
      e.MULTITAP_TLS_CERT_FILE === undefined ? 'MULTITAP_TLS_CERT_FILE' : 'MULTITAP_TLS_KEY_FILE',
      'MULTITAP_TLS_CERT_FILE and MULTITAP_TLS_KEY_FILE must be set together',
    );
  }
  if (
    e.MULTITAP_ENGINE_SESSION_TTL_MS !== undefined &&
    e.MULTITAP_ENGINE_SESSION_TTL_MS < e.MULTITAP_RETENTION_IDLE_MS
  ) {
    problem(
      'MULTITAP_ENGINE_SESSION_TTL_MS',
      'Must not be shorter than MULTITAP_RETENTION_IDLE_MS (the engine would evict sessions Multitap still keeps)',
    );
  }
  if (e.MULTITAP_MEDIA_TOKEN_TTL_MS > e.MULTITAP_MEDIA_TOKEN_MAX_TTL_MS) {
    problem('MULTITAP_MEDIA_TOKEN_TTL_MS', 'Must not exceed MULTITAP_MEDIA_TOKEN_MAX_TTL_MS');
  }
  let tokenSecret: string | null = e.MULTITAP_MEDIA_TOKEN_SECRET ?? null;
  if (e.MULTITAP_MEDIA_TOKEN_SECRET_FILE !== undefined) {
    if (tokenSecret !== null) {
      problem(
        'MULTITAP_MEDIA_TOKEN_SECRET_FILE',
        'Set MULTITAP_MEDIA_TOKEN_SECRET or MULTITAP_MEDIA_TOKEN_SECRET_FILE, not both',
      );
    } else {
      try {
        tokenSecret = readFile(resolve(cwd, e.MULTITAP_MEDIA_TOKEN_SECRET_FILE));
        if (Buffer.byteLength(tokenSecret, 'utf8') < MIN_TOKEN_SECRET_BYTES) {
          problem(
            'MULTITAP_MEDIA_TOKEN_SECRET_FILE',
            `The file's secret must be at least ${String(MIN_TOKEN_SECRET_BYTES)} bytes`,
          );
        }
      } catch {
        problem('MULTITAP_MEDIA_TOKEN_SECRET_FILE', 'Could not be read');
      }
    }
  }
  if (e.MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS !== undefined && tokenSecret === null) {
    problem(
      'MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS',
      'Needs MULTITAP_MEDIA_TOKEN_SECRET or MULTITAP_MEDIA_TOKEN_SECRET_FILE',
    );
  }
  if (e.MULTITAP_LOG_DIR === undefined && !e.MULTITAP_LOG_STDOUT) {
    problem(
      'MULTITAP_LOG_STDOUT',
      'Cannot be false without MULTITAP_LOG_DIR: Multitap would log nowhere',
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const dataDir = resolve(cwd, e.MULTITAP_DATA_DIR);

  return {
    apiPort: e.MULTITAP_API_PORT,
    apiBind: e.MULTITAP_API_BIND ?? null,
    dataDir,
    logLevel: e.MULTITAP_LOG_LEVEL,
    logging: {
      dir: e.MULTITAP_LOG_DIR === undefined ? null : resolve(cwd, e.MULTITAP_LOG_DIR),
      stdout: e.MULTITAP_LOG_STDOUT,
      fileKeep: e.MULTITAP_LOG_FILE_KEEP,
      fileMaxSizeBytes: e.MULTITAP_LOG_FILE_MAX_SIZE,
    },
    nodeEnv: e.NODE_ENV,
    backup: {
      dir:
        e.MULTITAP_BACKUP_DIR === undefined
          ? resolve(dataDir, 'backups')
          : resolve(cwd, e.MULTITAP_BACKUP_DIR),
      intervalMs: e.MULTITAP_BACKUP_INTERVAL_MS,
      keep: e.MULTITAP_BACKUP_KEEP,
    },
    media: {
      port: e.MULTITAP_MEDIA_PORT,
      bind: e.MULTITAP_MEDIA_BIND ?? null,
      tokenSecret,
      previousTokenSecret: e.MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS ?? null,
      tokenTtlMs: e.MULTITAP_MEDIA_TOKEN_TTL_MS,
      tokenMaxTtlMs: e.MULTITAP_MEDIA_TOKEN_MAX_TTL_MS,
      publicBase: e.MULTITAP_MEDIA_PUBLIC_BASE ?? null,
    },
    corsOrigins: e.MULTITAP_CORS_ORIGINS,
    tls:
      e.MULTITAP_TLS_CERT_FILE !== undefined && e.MULTITAP_TLS_KEY_FILE !== undefined
        ? {
            certFile: resolve(cwd, e.MULTITAP_TLS_CERT_FILE),
            keyFile: resolve(cwd, e.MULTITAP_TLS_KEY_FILE),
          }
        : null,
    sessions: {
      maxBitrate: e.MULTITAP_SESSION_MAX_BITRATE,
      bitrateByHeight: ladder,
      retentionIdleMs: e.MULTITAP_RETENTION_IDLE_MS,
      releasedKeepMs: e.MULTITAP_SESSION_RELEASED_KEEP_MS,
      sweepIntervalMs: e.MULTITAP_RETENTION_SWEEP_MS,
    },
    selection: {
      defaultHighRes: e.MULTITAP_SELECTION_DEFAULT_HIGH_RES,
      defaultEngine: e.MULTITAP_SELECTION_DEFAULT_ENGINE,
      preferredLanguage: e.MULTITAP_SELECTION_PREFERRED_LANGUAGE,
      streamStoreTtlMs: e.MULTITAP_STREAM_STORE_TTL_MS,
      autoMaxAttempts: e.MULTITAP_AUTO_SELECT_MAX_ATTEMPTS,
      autoRetryAfterMs: e.MULTITAP_AUTO_SELECT_RETRY_AFTER_MS,
      autoAttemptTimeoutMs:
        e.MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS === 0
          ? null
          : e.MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS,
    },
    addons: {
      timeoutsMs: {
        catalog: e.MULTITAP_ADDON_TIMEOUT_CATALOG_MS,
        meta: e.MULTITAP_ADDON_TIMEOUT_META_MS,
        streams: e.MULTITAP_ADDON_TIMEOUT_STREAMS_MS,
        subtitles: e.MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS,
      },
      manifestTimeoutMs: e.MULTITAP_ADDON_TIMEOUT_MANIFEST_MS,
      manifestRefreshMs: e.MULTITAP_ADDON_MANIFEST_REFRESH_MS,
      responseCacheEntries: e.MULTITAP_ADDON_RESPONSE_CACHE_ENTRIES,
      circuitFailures: e.MULTITAP_ADDON_CIRCUIT_FAILURES,
      circuitResetMs: e.MULTITAP_ADDON_CIRCUIT_RESET_MS,
      userAgent: e.MULTITAP_ADDON_USER_AGENT,
      defaultManifestUrls: e.MULTITAP_DEFAULT_ADDONS,
      privateAllow: e.MULTITAP_ADDON_PRIVATE_ALLOW,
    },
    subtitles: {
      timeoutMs: e.MULTITAP_SUBTITLE_TIMEOUT_MS,
      maxBytes: e.MULTITAP_SUBTITLE_MAX_BYTES,
    },
    engines: {
      healthIntervalMs: e.MULTITAP_ENGINE_HEALTH_INTERVAL_MS,
      healthTimeoutMs: e.MULTITAP_ENGINE_HEALTH_TIMEOUT_MS,
      healthMaxBackoffMs: e.MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS,
      connectTimeoutMs: e.MULTITAP_ENGINE_CONNECT_TIMEOUT_MS,
      sessionTtlMs: e.MULTITAP_ENGINE_SESSION_TTL_MS ?? null,
      admission: e.MULTITAP_ENGINE_ADMISSION,
      loadWindowMs: e.MULTITAP_ENGINE_LOAD_WINDOW_MS,
      timeoutsMs: {
        control: e.MULTITAP_ENGINE_TIMEOUT_CONTROL_MS,
        prepare: e.MULTITAP_ENGINE_TIMEOUT_PREPARE_MS,
        media: e.MULTITAP_ENGINE_TIMEOUT_MEDIA_MS,
      },
    },
    events: {
      replaySize: e.MULTITAP_EVENTS_REPLAY_SIZE,
      heartbeatMs: e.MULTITAP_EVENTS_HEARTBEAT_MS,
    },
  };
}
