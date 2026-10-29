import type { Addon, AddonStatus } from '@multitap/api';
import { PrivateHostGuard, type ExtraValue } from '@multitap/addon-protocol';
import type { Clock } from '../auth/keys.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import {
  aggregate,
  type AddonOutcome,
  type AggregateOptions,
  type AggregateResource,
  type AggregateResult,
} from './aggregate.ts';
import { normalizedResources } from './capabilities.ts';
import type { CircuitBreakerOptions } from './circuit-breaker.ts';
import { AddonClients, type ResourceFetcher } from './client.ts';
import {
  AddonCollection,
  AddonCollectionError,
  needsConfiguration,
  type AddonRecord,
  type ManifestFetcher,
} from './collection.ts';

export type {
  AddonOutcome,
  AggregateOptions,
  AggregateResource,
  AggregateResult,
  ResourceItems,
} from './aggregate.ts';
export type { CatalogEntry } from './capabilities.ts';
export type { AddonCallStatus, CacheOutcome } from './client.ts';
export { AddonCollectionError, needsConfiguration, type AddonRecord } from './collection.ts';

export interface AddonServiceDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  config: Pick<Config, 'addons'>;
  /** Test seams. */
  fetchManifest?: ManifestFetcher;
  fetchResource?: ResourceFetcher;
  /** Overrides the circuit breaker settings from `config.addons`. */
  breaker?: CircuitBreakerOptions;
}

/** The longest gap between checks for manifests due a refresh. */
const MAX_REFRESH_TICK_MS = 5 * 60_000;

/**
 * Multitap's addons module (okf:architecture/core-modules): the collection with its manifest cache and
 * capability index, the client wrapper, and aggregation.
 */
export class AddonService {
  readonly collection: AddonCollection;
  readonly clients: AddonClients;
  /** Guards addon redirects and subtitle files (`config.addons.privateAllow`). */
  readonly guard: PrivateHostGuard;
  readonly #logger: Logger;
  readonly #refreshMs: number;
  readonly #defaults: readonly string[];
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(deps: AddonServiceDeps) {
    this.#logger = deps.logger;
    this.#refreshMs = deps.config.addons.manifestRefreshMs;
    this.#defaults = deps.config.addons.defaultManifestUrls;
    this.guard = new PrivateHostGuard({ allow: deps.config.addons.privateAllow });
    const collectionDeps: ConstructorParameters<typeof AddonCollection>[0] = {
      db: deps.db,
      logger: deps.logger,
      clock: deps.clock,
      manifestTimeoutMs: deps.config.addons.manifestTimeoutMs,
      guard: this.guard,
    };
    if (deps.fetchManifest) collectionDeps.fetchManifest = deps.fetchManifest;
    collectionDeps.userAgent = deps.config.addons.userAgent;
    this.collection = new AddonCollection(collectionDeps);
    const clientDeps: ConstructorParameters<typeof AddonClients>[0] = {
      logger: deps.logger,
      clock: deps.clock,
      timeoutsMs: deps.config.addons.timeoutsMs,
      cacheEntries: deps.config.addons.responseCacheEntries,
      guard: this.guard,
      breaker: deps.breaker ?? {
        failureThreshold: deps.config.addons.circuitFailures,
        resetMs: deps.config.addons.circuitResetMs,
      },
    };
    clientDeps.userAgent = deps.config.addons.userAgent;
    if (deps.fetchResource) clientDeps.fetchResource = deps.fetchResource;
    this.clients = new AddonClients(clientDeps);
    this.collection.onEvent((event) => {
      this.clients.forget(event.id);
    });
  }

  /**
   * Installs `config.addons.defaultManifestUrls` once, on first start: only
   * when the collection is empty, so addons the admin removes stay removed.
   * A URL that fails is skipped with a warning (host and code only).
   */
  async seedDefaults(): Promise<void> {
    if (this.#defaults.length === 0) return;
    if ((await this.collection.list()).length > 0) return;
    for (const url of this.#defaults) {
      try {
        await this.collection.add(url);
      } catch (err) {
        // `add` has logged the host and code; the URL itself is secret.
        this.#logger.warn(
          { code: err instanceof AddonCollectionError ? err.kind : 'unexpected' },
          'default addon not installed',
        );
      }
    }
  }

  /**
   * Starts the manifest refresh schedule: manifests due a refresh (none
   * attempted within the interval, including at startup) are refetched.
   */
  start(): void {
    if (this.#timer !== undefined) return;
    const tick = () => {
      this.#refreshing ??= this.collection
        .refreshStale(this.#refreshMs)
        .catch((err: unknown) => {
          // Database errors only; addon failures are handled per addon.
          this.#logger.error({ err }, 'scheduled manifest refresh failed');
        })
        .finally(() => {
          this.#refreshing = undefined;
        });
    };
    tick();
    this.#timer = setInterval(tick, Math.min(this.#refreshMs, MAX_REFRESH_TICK_MS));
    this.#timer.unref();
  }

  /** Stops the schedule and waits for a refresh in progress. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#refreshing;
  }

  aggregate<R extends AggregateResource>(
    resource: R,
    type: string,
    id: string,
    extra: readonly ExtraValue[] = [],
    options: AggregateOptions<R> = {},
  ): Promise<AggregateResult<R>> {
    return aggregate(this, resource, type, id, extra, options);
  }
}

/**
 * `{origin}/configure`, where the SDK serves an addon's configuration page.
 * Built from the origin alone: the rest of the manifest URL is secret.
 */
function configurationUrl(record: AddonRecord): string | null {
  const { configurable, configurationRequired } = record.manifest.behaviorHints;
  if (!configurable && !configurationRequired) return null;
  try {
    return `${new URL(record.manifestUrl).origin}/configure`;
  } catch {
    return null;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The API view of an addon (`@multitap/api`'s `Addon`). Never includes the manifest URL. */
export function addonView(record: AddonRecord): Addon {
  const { manifest } = record;
  return {
    id: record.id,
    manifestId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    logo: manifest.logo ?? null,
    host: record.host,
    types: manifest.types,
    resources: normalizedResources(manifest).map((r) => ({
      name: r.name,
      types: r.types,
      idPrefixes: r.idPrefixes ?? null,
    })),
    catalogs: manifest.catalogs.map((c) => ({
      type: c.type,
      id: c.id,
      name: c.name ?? null,
      extra: c.extra.map((e) => ({
        name: e.name,
        isRequired: e.isRequired,
        options: e.options,
        optionsLimit: e.optionsLimit,
      })),
    })),
    behaviorHints: {
      configurable: manifest.behaviorHints.configurable,
      configurationRequired: manifest.behaviorHints.configurationRequired,
      adult: manifest.behaviorHints.adult,
      p2p: manifest.behaviorHints.p2p,
    },
    state: needsConfiguration(record) ? 'needs-configuration' : 'ready',
    configurationUrl: configurationUrl(record),
    enabled: record.enabled,
    position: record.position,
    fetchedAt: iso(record.fetchedAt),
    refreshError:
      record.refreshError === null
        ? null
        : { code: record.refreshError.code, at: iso(record.refreshError.at) },
  };
}

/**
 * The API view of one addon's part of an aggregated request (`AddonStatus`).
 * `count` is what the route returned from it (default: its valid items);
 * `extraDropped` adds items the route left out on top of those that failed
 * validation. Every browse route reports addons through this.
 */
export function addonStatus(
  outcome: AddonOutcome<AggregateResource>,
  count: number = outcome.items.length,
  extraDropped = 0,
): AddonStatus {
  const status: AddonStatus = {
    addonId: outcome.addonId,
    addonName: outcome.addonName,
    status: outcome.status,
    count,
    dropped: outcome.dropped + extraDropped,
  };
  if (outcome.errorCode !== undefined) status.errorCode = outcome.errorCode;
  return status;
}
