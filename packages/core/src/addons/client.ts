import {
  AddonError,
  encodeResourcePath,
  fetchResource as stremioFetchResource,
  type AddonErrorCode,
  type AddonHttpStatusError,
  type AddonRequestOptions,
  type ParsedResourceResponse,
  type PrivateHostGuard,
  type ResourcePathInput,
} from '@multitap/addon-protocol';
import type { Clock } from '../auth/keys.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './circuit-breaker.ts';
import { ResponseCache } from './response-cache.ts';

/** What the client needs to know about an addon. */
export interface ClientAddon {
  id: string;
  /** Secret: passed to the stremio client only. */
  manifestUrl: string;
  host: string;
}

export type AddonCallStatus = 'ok' | 'timeout' | 'error' | 'circuit-open' | 'needs-configuration';

/** How an `ok` answer was served. */
export type CacheOutcome = 'miss' | 'fresh' | 'stale';

export type AddonCallResult =
  | { status: 'ok'; data: ParsedResourceResponse; cache: CacheOutcome }
  | {
      status: 'timeout' | 'error' | 'circuit-open';
      /** The stremio client's error code; absent for `circuit-open`. */
      errorCode?: AddonErrorCode | 'unexpected';
    };

export type ResourceFetcher = (
  url: string,
  path: ResourcePathInput,
  options: AddonRequestOptions,
) => Promise<ParsedResourceResponse>;

export interface AddonClientsDeps {
  logger: Logger;
  clock: Clock;
  timeoutsMs: Config['addons']['timeoutsMs'];
  /** Most responses kept across all addons. */
  cacheEntries: number;
  breaker?: CircuitBreakerOptions;
  /** The `User-Agent` sent to addons; the runtime's default when unset. */
  userAgent?: string;
  /** Default: `@multitap/addon-protocol`'s `fetchResource`. */
  fetchResource?: ResourceFetcher;
  /** Guards redirects (okf:architecture/addon-private-host-guard); the stremio client's default when unset. */
  guard?: PrivateHostGuard;
}

/** The per-request timeout for a resource (okf:concept/addon-aggregation). */
export function timeoutFor(timeouts: Config['addons']['timeoutsMs'], resource: string): number {
  switch (resource) {
    case 'meta':
      return timeouts.meta;
    case 'stream':
      return timeouts.streams;
    case 'subtitles':
      return timeouts.subtitles;
    default:
      return timeouts.catalog;
  }
}

/**
 * Errors that say the addon is unhealthy and count towards opening its
 * circuit. Any other failure (a 4xx, a response that fails validation, one
 * that's too large) means the addon answered.
 */
function isHealthFailure(err: unknown): boolean {
  if (!(err instanceof AddonError)) return true;
  switch (err.code) {
    case 'timeout':
    case 'network':
    case 'invalid-json':
      return true;
    case 'http-status':
      return (err as AddonHttpStatusError).status >= 500;
    default:
      return false;
  }
}

/**
 * The client wrapper (okf:architecture/core-modules `addons/client`): every addon request goes through
 * here for its timeout, the addon's circuit breaker, and the response cache.
 * Never throws for addon failures; logs only an error code, the host and the
 * addon id.
 */
export class AddonClients {
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #timeouts: Config['addons']['timeoutsMs'];
  readonly #breakerOptions: CircuitBreakerOptions | undefined;
  readonly #fetchResource: ResourceFetcher;
  readonly #headers: Record<string, string> | undefined;
  readonly #guard: PrivateHostGuard | undefined;
  readonly #cache: ResponseCache<ParsedResourceResponse>;
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #inFlight = new Map<string, Promise<AddonCallResult>>();
  readonly #background = new Set<Promise<unknown>>();

  constructor(deps: AddonClientsDeps) {
    this.#logger = deps.logger;
    this.#clock = deps.clock;
    this.#timeouts = deps.timeoutsMs;
    this.#breakerOptions = deps.breaker;
    this.#fetchResource = deps.fetchResource ?? stremioFetchResource;
    this.#headers = deps.userAgent === undefined ? undefined : { 'user-agent': deps.userAgent };
    this.#guard = deps.guard;
    this.#cache = new ResponseCache(deps.clock, deps.cacheEntries);
  }

  /** The addon's circuit state (for admin views and tests). */
  circuitState(addonId: string): CircuitState {
    return this.#breakers.get(addonId)?.state ?? 'closed';
  }

  /** Forgets an addon's cached responses and circuit (on removal or a manifest change). */
  forget(addonId: string): void {
    this.#breakers.delete(addonId);
    this.#cache.deletePrefix(`${addonId}\u0000`);
  }

  /** Resolves once background revalidations have finished (tests). */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Requests a resource from one addon. */
  async request(
    addon: ClientAddon,
    path: ResourcePathInput,
    signal?: AbortSignal,
  ): Promise<AddonCallResult> {
    const key = `${addon.id}\u0000${encodeResourcePath(path)}`;
    const cached = this.#cache.get(key);
    if (cached?.use === 'fresh') return { status: 'ok', data: cached.value, cache: 'fresh' };
    if (cached?.use === 'revalidate') {
      if (!this.#inFlight.has(key)) {
        const refresh = this.#shared(key, addon, path, undefined);
        this.#background.add(refresh);
        void refresh.finally(() => this.#background.delete(refresh));
      }
      return { status: 'ok', data: cached.value, cache: 'stale' };
    }

    // Callers with their own abort signal don't share an in-flight request.
    const result =
      signal === undefined
        ? await this.#shared(key, addon, path, undefined)
        : await this.#fetch(key, addon, path, signal);
    if (result.status !== 'ok' && cached?.use === 'on-error') {
      return { status: 'ok', data: cached.value, cache: 'stale' };
    }
    return result;
  }

  #shared(
    key: string,
    addon: ClientAddon,
    path: ResourcePathInput,
    signal: AbortSignal | undefined,
  ): Promise<AddonCallResult> {
    let pending = this.#inFlight.get(key);
    if (pending === undefined) {
      pending = this.#fetch(key, addon, path, signal).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, pending);
    }
    return pending;
  }

  #breaker(addonId: string): CircuitBreaker {
    let breaker = this.#breakers.get(addonId);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(this.#clock, this.#breakerOptions);
      this.#breakers.set(addonId, breaker);
    }
    return breaker;
  }

  async #fetch(
    key: string,
    addon: ClientAddon,
    path: ResourcePathInput,
    signal: AbortSignal | undefined,
  ): Promise<AddonCallResult> {
    const breaker = this.#breaker(addon.id);
    if (!breaker.tryAcquire()) return { status: 'circuit-open' };
    try {
      const options: AddonRequestOptions = { timeoutMs: timeoutFor(this.#timeouts, path.resource) };
      if (signal !== undefined) options.signal = signal;
      if (this.#headers !== undefined) options.headers = this.#headers;
      if (this.#guard !== undefined) options.guard = this.#guard;
      const data = await this.#fetchResource(addon.manifestUrl, path, options);
      breaker.success();
      if (data.dropped.length > 0) {
        this.#logger.info(
          {
            addonId: addon.id,
            host: addon.host,
            resource: path.resource,
            dropped: data.dropped.length,
          },
          'addon response items failed validation and were dropped',
        );
      }
      // Only a current breaker's cache is written: forget() may have run meanwhile.
      if (this.#breakers.get(addon.id) === breaker) this.#cache.set(key, data, data.cache);
      return { status: 'ok', data, cache: 'miss' };
    } catch (err) {
      const code = err instanceof AddonError ? err.code : 'unexpected';
      if (code === 'aborted') breaker.cancel();
      else if (isHealthFailure(err)) breaker.failure();
      else breaker.success();
      this.#logger.warn(
        { addonId: addon.id, host: addon.host, resource: path.resource, code },
        'addon request failed',
      );
      return { status: code === 'timeout' ? 'timeout' : 'error', errorCode: code };
    }
  }
}
