import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { AddonService } from './addons/index.ts';
import { BackupService, backupBeforeMigrating } from './backup/service.ts';
import { ConfigError, loadConfig, unknownVariables, type Config } from './config.ts';
import { DB_FILE, migrateToLatest, openDatabase, type Db } from './db/index.ts';
import { lockDataDir, type DataDirLock } from './db/instance-lock.ts';
import { ServerGoEngineModule, engineModuleConfig } from './engines/engine-module.ts';
import { EngineHealthMonitor } from './engines/health.ts';
import { checkEngines, defaultEngineId, getEngine } from './engines/index.ts';
import { EngineRegistry } from './engines/registry.ts';
import { createMediaApp } from './gateway/app.ts';
import { createGatewayServices } from './gateway/services.ts';
import { MemoryEventBus } from './events/memory-bus.ts';
import { createApp, type AppDeps } from './http/app.ts';
import {
  isLoopbackAddress,
  listen,
  onReloadSignal,
  readTlsMaterial,
  reloadTls,
  type Listener,
} from './http/listen.ts';
import { autoSourcesFor } from './http/selection-deps.ts';
import { randomIds } from './lib/ids.ts';
import { createLogger, flushLogFile, openLogFile, type Logger, type LogFileStream } from './log.ts';
import { addonMetaSource, LibraryService } from './library/service.ts';
import { MetricsRegistry } from './metrics/index.ts';
import { ItemMetaLookup } from './selection/item-meta.ts';
import { RankingSettingsStore } from './selection/ranking-settings.ts';
import { StreamStore } from './selection/stream-store.ts';
import { SessionService } from './sessions/service.ts';
import { SqliteSessionRepository } from './sessions/sqlite-repository.ts';
import { SubtitleService } from './subtitles/index.ts';

export { createApp, openApiDocument } from './http/app.ts';
export { loadConfig } from './config.ts';

export interface RunningMultitap {
  /** The port the API listener is bound to (tests pass `apiPort: 0` for a free one). */
  port: number;
  /** The port the media listener is bound to (`media.port: 0` picks a free one). */
  mediaPort: number;
  /**
   * Re-reads `MULTITAP_TLS_CERT_FILE`/`MULTITAP_TLS_KEY_FILE` and applies them to both listeners
   * for new connections (what `SIGHUP` does). A failure keeps the old
   * certificate and logs a warning. Returns whether the new pair was applied;
   * always `false` without TLS.
   */
  reloadTls(): boolean;
  /**
   * Ends open event streams, closes both listeners (letting open requests
   * finish for up to `CLOSE_GRACE_MS`), flushes held-back library progress,
   * closes the database, then releases the data folder's lock.
   */
  close(): Promise<void>;
}

/**
 * How long `main` waits for a graceful shutdown before it exits anyway: below
 * Docker's default 10 s stop grace, so Multitap's own exit (and its last log
 * lines) comes before Docker's `SIGKILL`. Listeners cut open responses after
 * `CLOSE_GRACE_MS` (5 s), which leaves the rest for flushing progress and
 * closing the database.
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/** How long `main` spends trying to flush after an uncaught error before it exits. */
export const CRASH_FLUSH_TIMEOUT_MS = 3_000;

/**
 * Opens and migrates the database, then serves the API on `config.apiPort` and
 * the media gateway on `config.media.port`, over HTTPS on both when
 * `config.tls` is set.
 */
export async function startMultitap(config: Config, logger: Logger): Promise<RunningMultitap> {
  // Read first, so a bad certificate fails startup before anything opens.
  const tls = config.tls === null ? null : readTlsMaterial(config.tls);
  // 0700 where the platform has modes: the database holds secrets, like its backups.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Before anything changes the database: a second instance on the same folder
  // stops here instead of migrating it and failing the live one's sessions.
  const lock = lockDataDir(config.dataDir);
  try {
    return await startLocked(config, logger, tls, lock);
  } catch (err) {
    lock.release();
    throw err;
  }
}

async function startLocked(
  config: Config,
  logger: Logger,
  tls: ReturnType<typeof readTlsMaterial> | null,
  lock: DataDirLock,
): Promise<RunningMultitap> {
  const db: Db = openDatabase(join(config.dataDir, DB_FILE));
  try {
    await migrateToLatest(db, logger, {
      beforeMigrating: (pending) =>
        backupBeforeMigrating(
          { db, logger, clock: Date.now, backupDir: config.backup.dir },
          pending,
        ),
    });
    await checkEngines(db, config.selection.defaultEngine, logger);
  } catch (err) {
    await db.destroy();
    throw err;
  }

  const clock = Date.now;
  const metrics = new MetricsRegistry();
  const addons = new AddonService({ config, db, logger, clock });
  const streams = new StreamStore({ clock, ttlMs: config.selection.streamStoreTtlMs });
  const subtitles = new SubtitleService({
    addons,
    clock,
    logger,
    timeoutMs: config.subtitles.timeoutMs,
    maxBytes: config.subtitles.maxBytes,
    guard: addons.guard,
  });
  const ids = randomIds;
  // `/v1/events` (okf:architecture/core-events-sse).
  const events = new MemoryEventBus({
    clock,
    replaySize: config.events.replaySize,
    logger,
    onSubscribers: (count) => {
      metrics.setEventSubscribers(count);
    },
  });
  // Loaded once and cached; writes through /v1/admin/ranking replace the cache.
  const ranking = new RankingSettingsStore({ db, clock, logger, events });
  try {
    await ranking.load();
  } catch (err) {
    await db.destroy();
    throw err;
  }
  const library = new LibraryService({ db, clock, logger, meta: addonMetaSource(addons) });
  // Engine clients and health checks (phase 2 step 2), shared with the engine module.
  const engineRegistry = new EngineRegistry({
    db,
    timeouts: config.engines.timeoutsMs,
    connectTimeoutMs: config.engines.connectTimeoutMs,
  });
  const engineHealth = new EngineHealthMonitor({
    db,
    registry: engineRegistry,
    logger,
    clock,
    intervalMs: config.engines.healthIntervalMs,
    timeoutMs: config.engines.healthTimeoutMs,
    maxBackoffMs: config.engines.healthMaxBackoffMs,
    bus: events,
    metrics,
  });
  const engineModule = new ServerGoEngineModule({
    db,
    registry: engineRegistry,
    logger,
    clock,
    ids,
    ...engineModuleConfig(config),
    privateHosts: addons.guard,
  });
  // Aborted by close(): ends open /v1/events streams (okf:architecture/core-events-sse).
  const shutdown = new AbortController();
  const appDeps: AppDeps = {
    shutdown: shutdown.signal,
    engineHealth: engineRegistry,
    config,
    db,
    logger,
    clock,
    addons,
    streams,
    subtitles,
    metrics,
    library,
    ranking,
    itemMeta: new ItemMetaLookup({ addons, clock }),
    events,
    ids,
  };
  // Playback sessions (phase 2 step 4): retention is swept on a timer from start().
  const sessionRepo = new SqliteSessionRepository(db);
  const sessions = new SessionService({
    repo: sessionRepo,
    engines: engineModule,
    getEngine: (id) => getEngine(db, id),
    defaultEngine: () => defaultEngineId(db, config.selection.defaultEngine),
    streams,
    autoSources: autoSourcesFor(appDeps),
    config,
    clock,
    ids,
    logger,
    events,
    metrics,
    profiles: library,
  });
  appDeps.sessions = sessions;
  // Media tokens, viewers and session subtitles (phase 2 step 5), shared by
  // the /v1 routes and the media listener. Subscribed before start() so the
  // token service sees every session change.
  const gateway = createGatewayServices({
    config,
    sessions,
    repo: sessionRepo,
    subtitles,
    clock,
    logger,
  });
  appDeps.gateway = gateway;
  // Database backups (okf:architecture/core-persistence): on a timer from start() when MULTITAP_BACKUP_INTERVAL_MS is set.
  const backups = new BackupService({ db, logger, clock, metrics, config });
  appDeps.backups = backups;
  // Stops what start() set going (the sweep timer and its first sweep, engine
  // calls), waits for it, then closes the database: a sweep must never meet a
  // closed database.
  const abandon = async () => {
    sessions.stop();
    engineModule.close();
    await Promise.all([sessions.idle(), engineModule.idle()]);
    await db.destroy();
  };
  try {
    await gateway.tokens.start();
    await sessions.start();
  } catch (err) {
    await abandon();
    throw err;
  }
  const app = createApp(appDeps);
  const mediaApp = createMediaApp({
    config,
    logger,
    services: { sessions, engines: engineModule, gateway, metrics },
  });
  let api: Listener;
  let media: Listener;
  try {
    api = await listen(app.fetch, config.apiPort, tls, config.apiBind);
    try {
      media = await listen(mediaApp.fetch, config.media.port, tls, config.media.bind);
    } catch (err) {
      await api.close();
      throw err;
    }
  } catch (err) {
    await abandon();
    throw err;
  }
  const port = api.port;
  logger.info(
    {
      port,
      mediaPort: media.port,
      apiBind: config.apiBind ?? 'all',
      mediaBind: config.media.bind ?? 'all',
      tls: tls !== null,
      dataDir: config.dataDir,
    },
    'Multitap listening',
  );
  // API keys are full credentials; over plain HTTP anyone on the path can lift
  // them (okf:architecture/network-and-deployment-exposure).
  const apiAddress = (api.server.address() as AddressInfo).address;
  if (tls === null && !isLoopbackAddress(apiAddress)) {
    logger.warn(
      { port, apiBind: config.apiBind ?? 'all' },
      `The /v1 API listens on ${config.apiBind === null ? 'every interface' : apiAddress} ` +
        'over plain HTTP: every request carries an API key in cleartext, readable by anyone ' +
        'on the network path. Bind it to loopback (MULTITAP_API_BIND=127.0.0.1), turn on TLS ' +
        '(MULTITAP_TLS_CERT_FILE and MULTITAP_TLS_KEY_FILE), or make sure only trusted hosts can reach the port ' +
        "(in Docker, don't publish it).",
    );
  }
  if (config.corsOrigins.length > 0 && config.media.publicBase === null) {
    logger.warn(
      'MULTITAP_CORS_ORIGINS is set but MULTITAP_MEDIA_PUBLIC_BASE is not: token responses carry only mediaPath, ' +
        'so browsers on other origins have no absolute media URL. Set MULTITAP_MEDIA_PUBLIC_BASE when the ' +
        'media listener is public.',
    );
  }
  // First start only (an empty collection); in the background, since the manifests are fetched.
  void addons.seedDefaults().catch((err: unknown) => {
    logger.error({ err }, 'seeding default addons failed');
  });
  addons.start();
  engineHealth.start();
  backups.start();

  let closing: Promise<void> | undefined;
  return {
    port,
    mediaPort: media.port,
    reloadTls() {
      return config.tls === null
        ? false
        : reloadTls([api.server, media.server], config.tls, logger);
    },
    close() {
      closing ??= (async () => {
        try {
          // First, so the event streams end and the API listener can close.
          shutdown.abort();
          engineHealth.stop();
          backups.stop();
          sessions.stop();
          engineModule.close();
          await Promise.all([api.close(), media.close(), engineHealth.idle()]);
          await Promise.all([sessions.idle(), engineModule.idle(), backups.idle()]);
          // Progress held back by the 90 s throttle (okf:architecture/library-and-profiles).
          await library.flush();
          await addons.stop();
          await db.destroy();
        } finally {
          lock.release();
        }
      })();
      return closing;
    },
  };
}

export interface ProcessHandlerDeps {
  logger: Logger;
  /** Graceful shutdown: `RunningMultitap.close()` once Multitap has started. */
  close: () => Promise<void>;
  /** Writes buffered log lines (the log file's included) before exiting. */
  flushLogs: () => void;
  exit: (code: number) => void;
  /** `RunningMultitap.reloadTls()`, or `null` without TLS. */
  reloadTls: (() => boolean) | null;
  shutdownTimeoutMs?: number;
  crashTimeoutMs?: number;
}

export interface ProcessHandlers {
  /** `SIGINT` / `SIGTERM`: graceful shutdown, exit 0 (1 if it fails or times out). */
  shutdown(signal: NodeJS.Signals): void;
  /** `SIGHUP`: reloads the TLS files when TLS is on; otherwise logged and ignored, never fatal. */
  reload(): void;
  /** `uncaughtException` / `unhandledRejection`: logged as fatal, a bounded graceful flush, exit 1. */
  crash(err: unknown, origin: string): void;
}

/**
 * What `main` does on signals and uncaught errors (okf:architecture/core-deployment).
 * Every path ends in one exit: a second signal or error during shutdown only
 * raises the exit code, and a timer forces the exit if closing hangs.
 */
export function processHandlers(deps: ProcessHandlerDeps): ProcessHandlers {
  const { logger } = deps;
  let exitCode = 0;
  let stopping = false;
  const stop = (code: number, timeoutMs: number) => {
    exitCode = Math.max(exitCode, code);
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => {
      logger.warn('shutdown timed out; exiting');
      deps.flushLogs();
      deps.exit(1);
    }, timeoutMs);
    force.unref();
    // Through then(), so a close() that throws is handled like one that rejects.
    void Promise.resolve()
      .then(() => deps.close())
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        exitCode = 1;
      })
      .finally(() => {
        clearTimeout(force);
        deps.flushLogs();
        deps.exit(exitCode);
      });
  };
  return {
    shutdown(signal) {
      logger.info({ signal }, 'shutting down');
      stop(0, deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    },
    reload() {
      if (deps.reloadTls === null) {
        logger.info({ signal: 'SIGHUP' }, 'SIGHUP ignored: there is no TLS certificate to reload');
        return;
      }
      deps.reloadTls();
    },
    crash(err, origin) {
      logger.fatal({ err, origin }, 'uncaught error; shutting down');
      // Flushed at once too, in case closing never gets that far.
      deps.flushLogs();
      stop(1, deps.crashTimeoutMs ?? CRASH_FLUSH_TIMEOUT_MS);
    },
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  let file: LogFileStream | undefined;
  try {
    file = config.logging.dir === null ? undefined : await openLogFile(config.logging);
  } catch (err) {
    process.stderr.write(`MULTITAP_LOG_DIR is not usable: ${err instanceof Error ? err.message : ''}
`);
    process.exit(1);
  }
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
    file,
    stdout: config.logging.stdout,
  });
  const unknown = unknownVariables(process.env);
  if (unknown.length > 0) {
    // Names only: a value may be a secret.
    logger.warn(
      { variables: unknown },
      `Multitap doesn't read ${unknown.join(', ')} (a typo, or a setting of another version?); ` +
        'unknown MULTITAP_ variables are ignored',
    );
  }
  let multitap: RunningMultitap | undefined;
  const handlers = processHandlers({
    logger,
    close: () => multitap?.close() ?? Promise.resolve(),
    flushLogs: () => {
      logger.flush();
      flushLogFile(file);
    },
    exit: (code) => process.exit(code),
    reloadTls: config.tls === null ? null : () => multitap?.reloadTls() ?? false,
  });
  // Installed before startup, so an error a background task throws while
  // Multitap starts is logged too; then progress is flushed where possible.
  process.on('uncaughtException', (err, origin) => {
    handlers.crash(err, origin);
  });
  process.on('unhandledRejection', (reason) => {
    handlers.crash(reason, 'unhandledRejection');
  });
  try {
    multitap = await startMultitap(config, logger);
  } catch (err) {
    logger.fatal({ err }, 'Multitap failed to start');
    flushLogFile(file);
    process.exitCode = 1;
    return;
  }

  const onSignal = (signal: NodeJS.Signals) => {
    handlers.shutdown(signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Always handled, so a SIGHUP (a closed terminal, a supervisor's reload)
  // never kills Multitap without a graceful shutdown. With TLS, a tool that
  // renews the certificate signals Multitap instead of restarting it (Linux
  // and Docker; Windows has no SIGHUP, so restart there).
  onReloadSignal(() => {
    handlers.reload();
  });
}

if (import.meta.main) {
  await main();
}
