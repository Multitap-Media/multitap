/**
 * The selection services the routes use: the injected ones, or (for apps built
 * without them, as most tests do) one per deps object, created on first use.
 * Nothing is touched while the app is only being built for its document.
 */
import { ServerGoEngineModule, engineModuleConfig } from '../engines/engine-module.ts';
import { defaultEngineId, getEngine } from '../engines/index.ts';
import { BackupService } from '../backup/service.ts';
import { createGatewayServices, type GatewayServices } from '../gateway/services.ts';
import { EngineRegistry } from '../engines/registry.ts';
import { randomIds } from '../lib/ids.ts';
import { addonMetaSource, LibraryService } from '../library/service.ts';
import { ItemMetaLookup } from '../selection/item-meta.ts';
import { RankingSettingsStore } from '../selection/ranking-settings.ts';
import { listSources } from '../selection/source-list.ts';
import { SessionService, type AutoSources } from '../sessions/service.ts';
import { SqliteSessionRepository } from '../sessions/sqlite-repository.ts';
import type { ProfileSelection } from '../library/service.ts';
import { ProblemError } from './problem.ts';
import type { AppDeps } from './types.ts';

const rankingStores = new WeakMap<AppDeps, RankingSettingsStore>();
const metaLookups = new WeakMap<AppDeps, ItemMetaLookup>();
const sessionServices = new WeakMap<AppDeps, SessionService>();
const backupServices = new WeakMap<AppDeps, BackupService>();
const libraryServices = new WeakMap<AppDeps, LibraryService>();
const gatewayServicesByDeps = new WeakMap<AppDeps, GatewayServices>();

export function rankingStore(deps: AppDeps): RankingSettingsStore {
  if (deps.ranking !== undefined) return deps.ranking;
  let store = rankingStores.get(deps);
  if (store === undefined) {
    store = new RankingSettingsStore({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      events: deps.events,
    });
    rankingStores.set(deps, store);
  }
  return store;
}

export function itemMetaLookup(deps: AppDeps): ItemMetaLookup {
  if (deps.itemMeta !== undefined) return deps.itemMeta;
  let lookup = metaLookups.get(deps);
  if (lookup === undefined) {
    lookup = new ItemMetaLookup({ addons: deps.addons, clock: deps.clock });
    metaLookups.set(deps, lookup);
  }
  return lookup;
}

/** The app's library service: `deps.library`, or one built from the other deps on first use. */
export function libraryService(deps: AppDeps): LibraryService {
  if (deps.library !== undefined) return deps.library;
  let service = libraryServices.get(deps);
  if (service === undefined) {
    service = new LibraryService({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      meta: addonMetaSource(deps.addons),
    });
    libraryServices.set(deps, service);
  }
  return service;
}

/**
 * A source list's or session's profile part (okf:concept/source-ranking, okf:decision/auto-select-and-fallback): the profile's audio
 * languages and its last source for the video. Undefined without a
 * `profileId`; throws a `400` problem for an unknown one.
 */
export async function profileSelection(
  deps: AppDeps,
  profileId: string | undefined,
  videoId: string,
): Promise<ProfileSelection | undefined> {
  if (profileId === undefined) return undefined;
  const selection = await libraryService(deps).selection(profileId, videoId);
  if (selection === undefined) throw new ProblemError(400, `Unknown profile '${profileId}'.`);
  return selection;
}

/** Auto-select's ranked source list (okf:decision/auto-select-and-fallback): the standard source list for the session's item. */
export function autoSourcesFor(deps: AppDeps): AutoSources {
  return async ({ item, engine, highRes, preferredLanguages, preferBingeGroup, lastSource }) => {
    const { candidates } = await listSources(
      { addons: deps.addons, streams: deps.streams, meta: itemMetaLookup(deps) },
      {
        type: item.type,
        videoId: item.videoId ?? item.id,
        engine,
        highRes,
        rank: {
          settings: await rankingStore(deps).effective(),
          // Already resolved by the session service (request > profile > instance).
          preferredLanguages,
          preferBingeGroup,
          lastSource,
        },
      },
    );
    return candidates;
  };
}

/** The backup service: Multitap's own, or one over `db` (no schedule) created on first use. */
export function backupService(deps: AppDeps): BackupService {
  if (deps.backups !== undefined) return deps.backups;
  let service = backupServices.get(deps);
  if (service === undefined) {
    service = new BackupService({
      db: deps.db,
      logger: deps.logger,
      clock: deps.clock,
      metrics: deps.metrics,
      config: deps.config,
    });
    backupServices.set(deps, service);
  }
  return service;
}

export function sessionService(deps: AppDeps): SessionService {
  if (deps.sessions !== undefined) return deps.sessions;
  let service = sessionServices.get(deps);
  if (service === undefined) {
    const registry = new EngineRegistry({
      db: deps.db,
      timeouts: deps.config.engines.timeoutsMs,
      connectTimeoutMs: deps.config.engines.connectTimeoutMs,
    });
    const ids = deps.ids ?? randomIds;
    service = new SessionService({
      repo: new SqliteSessionRepository(deps.db),
      engines: new ServerGoEngineModule({
        db: deps.db,
        registry,
        logger: deps.logger,
        clock: deps.clock,
        ids,
        ...engineModuleConfig(deps.config),
        privateHosts: deps.addons.guard,
      }),
      getEngine: (id) => getEngine(deps.db, id),
      defaultEngine: () => defaultEngineId(deps.db, deps.config.selection.defaultEngine),
      streams: deps.streams,
      autoSources: autoSourcesFor(deps),
      config: deps.config,
      clock: deps.clock,
      ids,
      logger: deps.logger,
      events: deps.events,
      metrics: deps.metrics,
      profiles: libraryService(deps),
    });
    sessionServices.set(deps, service);
  }
  return service;
}

/** The gateway's services: the injected ones, or one set per deps object, created on first use. */
export function gatewayServices(deps: AppDeps): GatewayServices {
  if (deps.gateway !== undefined) return deps.gateway;
  let services = gatewayServicesByDeps.get(deps);
  if (services === undefined) {
    services = createGatewayServices({
      config: deps.config,
      sessions: sessionService(deps),
      repo: new SqliteSessionRepository(deps.db),
      subtitles: deps.subtitles,
      clock: deps.clock,
      logger: deps.logger,
    });
    gatewayServicesByDeps.set(deps, services);
  }
  return services;
}
