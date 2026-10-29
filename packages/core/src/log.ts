import { join } from 'node:path';
import { multistream, pino, transport, type DestinationStream, type Logger } from 'pino';
import type { Config, LogLevel } from './config.ts';

export type { Logger } from 'pino';

/**
 * Keys whose values are secrets wherever they appear in a logged object
 * (okf:architecture/secrets-policy): credentials, addon manifest URLs (they embed debrid
 * keys), engine media URLs, stream URLs, raw addon `Stream`s, engine proxy
 * passwords, and the secret database columns (`SECRET_COLUMNS` in
 * db/schema.ts). Values held as a `Secret` (lib/secret.ts) serialize as
 * `[redacted]` under any key and at every level, `debug` included.
 */
export const SECRET_KEYS = [
  'authorization',
  'Authorization',
  'cookie',
  'apiKey',
  'api_key',
  'keyHash',
  'key_hash',
  'token',
  'manifestUrl',
  'manifest_url',
  'transportUrl',
  'mediaURL',
  'mediaUrl',
  'media_url',
  'url',
  'externalUrl',
  'stream',
  'rawStream',
  'streamJson',
  'stream_json',
  'mediaPath',
  'path',
  'password',
  'proxyPassword',
  'proxy_password',
  'apiPassword',
  'api_password',
] as const;

/**
 * How deep a secret key is redacted. pino's `*` matches exactly one level (an
 * object key or an array index), so each key is listed at every depth up to
 * this one: `url`, `*.url`, `*.*.url`, … `streams[3].url` is depth 2.
 */
export const REDACT_DEPTH = 6;

export const REDACT_CENSOR = '[redacted]';

export const REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((key) =>
  Array.from({ length: REDACT_DEPTH + 1 }, (_, depth) => '*.'.repeat(depth) + key),
);

/**
 * Levels at which Multitap redacts nothing (okf:architecture/secrets-policy): an operator debugging Multitap sees
 * exactly what it sent and received. Such logs contain credentials.
 */
export const UNREDACTED_LEVELS: readonly LogLevel[] = ['debug', 'trace'];

/** True when a logger at `level` redacts secrets (`info` and above, and `silent`). */
export function redactsAt(level: LogLevel): boolean {
  return !UNREDACTED_LEVELS.includes(level);
}

export const UNREDACTED_WARNING =
  'log level is debug or trace: secrets are NOT redacted and these logs contain credentials; treat them as secret';

/** UNREDACTED_WARNING when log files are written too. */
export const UNREDACTED_FILES_WARNING = `${UNREDACTED_WARNING}; so will the log files in MULTITAP_LOG_DIR: they contain credentials too`;

/** A rotating log file stream; `flushSync` writes what is buffered (call it before exit). */
export type LogFileStream = DestinationStream & { flushSync(): void; end(): void };

/**
 * Opens the rotating JSON log file (`MULTITAP_LOG_DIR`, okf:architecture/configuration): `multitap.<yyyy-MM-dd>.<n>.log`,
 * a new file each day and whenever one reaches `MULTITAP_LOG_FILE_MAX_SIZE`, the newest
 * `MULTITAP_LOG_FILE_KEEP` rotated files kept (older ones, from earlier runs too, are
 * removed on rotation). pino-roll is used as a plain stream, not as a worker
 * transport, so rotation runs in-process.
 */
export async function openLogFile(logging: Config['logging']): Promise<LogFileStream> {
  if (logging.dir === null) throw new Error('MULTITAP_LOG_DIR is not set');
  // Loaded on demand: it pulls in date-fns, which the CLI and tests don't need.
  const { default: roll } = await import('pino-roll');
  return (await roll({
    file: join(logging.dir, 'multitap'),
    extension: '.log',
    dateFormat: 'yyyy-MM-dd',
    frequency: 'daily',
    // pino-roll reads a unit-less number as MB, so give kilobytes explicitly.
    size: `${String(Math.max(1, Math.floor(logging.fileMaxSizeBytes / 1024)))}k`,
    limit: { count: logging.fileKeep, removeOtherLogFiles: true },
    mkdir: true,
  })) as LogFileStream;
}

/** Writes what the log file has buffered; a stream that is not open yet has nothing to write. */
export function flushLogFile(file: LogFileStream | undefined): void {
  try {
    file?.flushSync();
  } catch {
    // "sonic boom is not ready yet": nothing was written.
  }
}

export interface LoggerOptions {
  level: LogLevel;
  /** Human-readable output via pino-pretty (a dev dependency); development only. */
  pretty?: boolean;
  /** Where JSON lines go (default stdout). Ignored when `pretty` is set. */
  destination?: DestinationStream;
  /** An additional log file stream ({@link openLogFile}); receives every line the level lets through. */
  file?: DestinationStream | undefined;
  /** Whether lines also go to stdout (default true); only meaningful with `file`. */
  stdout?: boolean;
}

/**
 * Creates Multitap's logger. At `info` and above every secret key is redacted; at
 * `debug`/`trace` nothing is, and the logger's first line is a warning naming
 * the level (okf:architecture/secrets-policy). The level is fixed for the logger's lifetime.
 */
export function createLogger(options: LoggerOptions): Logger {
  const redact = redactsAt(options.level);
  const base = {
    level: options.level,
    ...(redact ? { redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } } : {}),
    base: undefined,
  };
  let logger: Logger;
  if (options.file !== undefined) {
    // One entry per destination; each passes every level the logger lets through.
    const streams: { level: string; stream: DestinationStream }[] = [
      { level: 'trace', stream: options.file },
    ];
    if (options.stdout !== false) {
      streams.unshift({
        level: 'trace',
        stream: options.pretty
          ? transport({
              target: 'pino-pretty',
              options: { destination: 1, translateTime: 'SYS:HH:MM:ss.l' },
            })
          : (options.destination ?? process.stdout),
      });
    }
    logger = pino(base, multistream(streams));
  } else if (options.pretty) {
    logger = pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { destination: 1, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  } else {
    logger = options.destination ? pino(base, options.destination) : pino(base);
  }
  if (!redact) {
    logger.warn(
      { logLevel: options.level },
      options.file === undefined ? UNREDACTED_WARNING : UNREDACTED_FILES_WARNING,
    );
  }
  return logger;
}
