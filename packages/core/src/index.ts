import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { AddonService } from './addons/index.ts';
import { BackupService, backupBeforeMigrating } from './backup/service.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { DB_FILE, migrateToLatest, openDatabase } from './db/index.ts';
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
   * then closes the database.
   */
  close(): Promise<void>;
}

/**
 * Opens and migrates the database, then serves the API on `config.apiPort` and
 * the media gateway on `config.media.port`, over HTTPS on both when
 * `config.tls` is set.
 */
export async function startMultitap(config: Config, logger: Logger): Promise<RunningMultitap> {
  // Read first, so a bad certificate fails startup before anything opens.
  const tls = config.tls === null ? null : readTlsMaterial(config.tls);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(join(config.dataDir, DB_FILE));
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
  try {
    await gateway.tokens.start();
    await sessions.start();
  } catch (err) {
    await db.destroy();
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
    sessions.stop();
    await db.destroy();
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
      })();
      return closing;
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
  let multitap: RunningMultitap;
  try {
    multitap = await startMultitap(config, logger);
  } catch (err) {
    logger.fatal({ err }, 'Multitap failed to start');
    flushLogFile(file);
    process.exitCode = 1;
    return;
  }

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.warn('shutdown timed out; exiting');
      flushLogFile(file);
      process.exit(1);
    }, 10_000);
    force.unref();
    multitap.close().then(
      () => {
        logger.flush();
        flushLogFile(file);
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        flushLogFile(file);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // A tool that renews the certificate signals Multitap instead of restarting it
  // (Linux and Docker; Windows has no SIGHUP, so restart there).
  if (config.tls !== null) {
    onReloadSignal(() => {
      multitap.reloadTls();
    });
  }
}

if (import.meta.main) {
  await main();
}
