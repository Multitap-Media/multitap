import { randomUUID } from 'node:crypto';
import {
  AddonError,
  fetchManifest as stremioFetchManifest,
  ManifestSchema,
  parseTransportUrl,
  type AddonRequestOptions,
  type Manifest,
  type PrivateHostGuard,
} from '@multitap/addon-protocol';
import type { Clock } from '../auth/keys.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { CapabilityIndex } from './capabilities.ts';

/** Timeout for fetching a manifest. */
export const MANIFEST_TIMEOUT_MS = 10_000;

/** An addon in the collection, as Multitap holds it in memory. */
export interface AddonRecord {
  id: string;
  /** Secret (okf:architecture/secrets-classes-and-engine-password): never logged, returned, or put in an error message. */
  manifestUrl: string;
  /** The manifest URL's hostname: the only part of it that may be shown. */
  host: string;
  enabled: boolean;
  position: number;
  /** The last good manifest. */
  manifest: Manifest;
  fetchedAt: number;
  createdAt: number;
  /** Set when the latest refresh failed; cleared by the next good one. */
  refreshError: { code: string; at: number } | null;
  /** When a refresh last ran, successful or not (memory only; drives the schedule). */
  lastAttemptAt: number;
}

/** Whether the addon says it can't work before it is configured; Multitap doesn't query it. */
export function needsConfiguration(record: Pick<AddonRecord, 'manifest'>): boolean {
  return record.manifest.behaviorHints.configurationRequired;
}

export type AddonCollectionErrorKind =
  | 'not-found'
  | 'duplicate'
  | 'invalid-url'
  | 'unsupported-transport'
  | 'manifest-unavailable'
  | 'order-mismatch';

/**
 * A collection operation that can't be done. Messages are written for API
 * clients and never contain the manifest URL.
 */
export class AddonCollectionError extends Error {
  override name = 'AddonCollectionError';
  readonly kind: AddonCollectionErrorKind;
  /** For `manifest-unavailable`: the stremio client's error code (`timeout`, `validation`, …). */
  readonly code: string | undefined;

  constructor(kind: AddonCollectionErrorKind, message: string, code?: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

export type ManifestFetcher = (url: string, options: AddonRequestOptions) => Promise<Manifest>;

export interface AddonCollectionDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  /** Default: `@multitap/addon-protocol`'s `fetchManifest`. */
  fetchManifest?: ManifestFetcher;
  manifestTimeoutMs?: number;
  /** The `User-Agent` sent with manifest requests. */
  userAgent?: string;
  /** Guards the manifest's redirects (okf:architecture/addon-private-host-guard). */
  guard?: PrivateHostGuard;
}

export type CollectionEvent = { type: 'removed'; id: string } | { type: 'changed'; id: string };

/**
 * Parses an admin-supplied manifest URL into the form that's stored and
 * compared for duplicates. `stremio://` (the install-link scheme) means
 * `https://`. The fragment is dropped.
 */
export function normalizeManifestUrl(input: string): URL {
  let text = input.trim();
  if (/^stremio:\/\//i.test(text)) text = `https://${text.slice('stremio://'.length)}`;
  let url: URL;
  try {
    url = parseTransportUrl(text);
  } catch (err) {
    if (err instanceof AddonError && err.code === 'unsupported-transport') {
      throw new AddonCollectionError(
        'unsupported-transport',
        'The manifest URL must end in /manifest.json; legacy addons are not supported.',
      );
    }
    throw new AddonCollectionError(
      'invalid-url',
      'The manifest URL is not a valid http or https URL.',
    );
  }
  url.hash = '';
  return url;
}

function errorCode(err: unknown): string {
  return err instanceof AddonError ? err.code : 'unexpected';
}

function isUniqueViolation(err: unknown): boolean {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/**
 * The addon collection over the `addons` table (okf:concept/addon-aggregation, okf:architecture/core-persistence), with the manifest
 * cache in memory. Loaded from the database on first use. Mutations are
 * serialized, so positions stay 0..n-1 in collection order.
 */
export class AddonCollection {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #fetchManifest: ManifestFetcher;
  readonly #manifestTimeoutMs: number;
  readonly #headers: Record<string, string> | undefined;
  readonly #guard: PrivateHostGuard | undefined;
  readonly #listeners: ((event: CollectionEvent) => void)[] = [];
  #records: AddonRecord[] = [];
  #index: CapabilityIndex<AddonRecord> | undefined;
  #loaded: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: AddonCollectionDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
    this.#clock = deps.clock;
    this.#fetchManifest = deps.fetchManifest ?? stremioFetchManifest;
    this.#manifestTimeoutMs = deps.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
    this.#headers = deps.userAgent === undefined ? undefined : { 'user-agent': deps.userAgent };
    this.#guard = deps.guard;
  }

  /** Called after an addon is removed or its manifest or state changes. */
  onEvent(listener: (event: CollectionEvent) => void): void {
    this.#listeners.push(listener);
  }

  /** Every addon, in collection order. */
  async list(): Promise<readonly AddonRecord[]> {
    await this.#load();
    return this.#records;
  }

  async get(id: string): Promise<AddonRecord | undefined> {
    await this.#load();
    return this.#records.find((record) => record.id === id);
  }

  /** The capability index over the enabled addons. */
  async index(): Promise<CapabilityIndex<AddonRecord>> {
    await this.#load();
    this.#index ??= new CapabilityIndex(this.#records);
    return this.#index;
  }

  /**
   * Fetches and validates the manifest, then appends the addon to the end of
   * the collection, enabled.
   *
   * @throws {AddonCollectionError} `invalid-url`, `unsupported-transport`,
   *   `duplicate` or `manifest-unavailable`.
   */
  async add(manifestUrl: string): Promise<AddonRecord> {
    const url = normalizeManifestUrl(manifestUrl);
    await this.#load();
    const duplicate = () =>
      new AddonCollectionError(
        'duplicate',
        'An addon with this manifest URL is already installed.',
      );
    if (this.#records.some((r) => r.manifestUrl === url.href)) throw duplicate();

    const manifest = await this.#fetchOrThrow(url);

    return this.#exclusive(async () => {
      if (this.#records.some((r) => r.manifestUrl === url.href)) throw duplicate();
      const now = this.#clock();
      const record: AddonRecord = {
        id: randomUUID(),
        manifestUrl: url.href,
        host: url.hostname,
        enabled: true,
        position: this.#records.length,
        manifest,
        fetchedAt: now,
        createdAt: now,
        refreshError: null,
        lastAttemptAt: now,
      };
      try {
        await this.#db
          .insertInto('addons')
          .values({
            id: record.id,
            manifest_url: record.manifestUrl,
            enabled: 1,
            position: record.position,
            manifest_json: JSON.stringify(manifest),
            manifest_fetched_at: now,
            created_at: now,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate();
        throw err;
      }
      this.#records = [...this.#records, record];
      this.#changed(record.id);
      this.#logger.info(
        { addonId: record.id, manifestId: manifest.id, host: record.host },
        'addon added',
      );
      return record;
    });
  }

  /**
   * Fetches and validates a manifest without storing anything. Same URL rules
   * and errors as {@link add}, minus `duplicate`; nothing is logged above
   * `warn` and no log line carries the URL.
   *
   * @throws {AddonCollectionError} `invalid-url`, `unsupported-transport` or
   *   `manifest-unavailable`.
   */
  async preview(manifestUrl: string): Promise<AddonRecord> {
    const url = normalizeManifestUrl(manifestUrl);
    await this.#load();
    const manifest = await this.#fetchOrThrow(url);
    const existing = this.#records.find((r) => r.manifestUrl === url.href);
    const now = this.#clock();
    return {
      // Empty for an addon that isn't installed.
      id: existing?.id ?? '',
      manifestUrl: url.href,
      host: url.hostname,
      enabled: existing?.enabled ?? true,
      position: existing?.position ?? this.#records.length,
      manifest,
      fetchedAt: now,
      createdAt: now,
      refreshError: null,
      lastAttemptAt: now,
    };
  }

  /** @throws {AddonCollectionError} `not-found` */
  async setEnabled(id: string, enabled: boolean): Promise<AddonRecord> {
    await this.#load();
    return this.#exclusive(async () => {
      const record = this.#require(id);
      if (record.enabled !== enabled) {
        await this.#db
          .updateTable('addons')
          .set({ enabled: enabled ? 1 : 0 })
          .where('id', '=', id)
          .execute();
        record.enabled = enabled;
        this.#changed(id);
        this.#logger.info({ addonId: id, enabled }, 'addon updated');
      }
      return record;
    });
  }

  /**
   * Puts the collection in the given order.
   *
   * @throws {AddonCollectionError} `order-mismatch` unless `ids` lists every
   *   addon exactly once.
   */
  async reorder(ids: readonly string[]): Promise<readonly AddonRecord[]> {
    await this.#load();
    return this.#exclusive(async () => {
      const byId = new Map(this.#records.map((r) => [r.id, r]));
      const unique = new Set(ids);
      if (
        unique.size !== ids.length ||
        ids.length !== this.#records.length ||
        ids.some((id) => !byId.has(id))
      ) {
        throw new AddonCollectionError(
          'order-mismatch',
          'The order must list every installed addon id exactly once.',
        );
      }
      const ordered = ids.map((id, position) => {
        // Every id was checked against byId above.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const record = byId.get(id)!;
        record.position = position;
        return record;
      });
      await this.#writePositions(ordered);
      this.#records = ordered;
      this.#changed(undefined);
      this.#logger.info({ count: ordered.length }, 'addons reordered');
      return this.#records;
    });
  }

  /** @throws {AddonCollectionError} `not-found` */
  async remove(id: string): Promise<void> {
    await this.#load();
    await this.#exclusive(async () => {
      this.#require(id);
      const rest = this.#records
        .filter((r) => r.id !== id)
        .map((r, position) => {
          r.position = position;
          return r;
        });
      await this.#db.transaction().execute(async (trx) => {
        await trx.deleteFrom('addons').where('id', '=', id).execute();
        for (const r of rest) {
          await trx
            .updateTable('addons')
            .set({ position: r.position })
            .where('id', '=', r.id)
            .execute();
        }
      });
      this.#records = rest;
      this.#index = undefined;
      for (const listener of this.#listeners) listener({ type: 'removed', id });
      this.#logger.info({ addonId: id }, 'addon removed');
    });
  }

  /**
   * Refetches one addon's manifest. On failure the last good manifest stays in
   * use and `refreshError` is set; this never throws for addon failures.
   *
   * @throws {AddonCollectionError} `not-found`
   */
  async refresh(id: string): Promise<AddonRecord> {
    await this.#load();
    const record = this.#require(id);
    return this.#refreshRecord(record);
  }

  /** Refetches every manifest (concurrently). */
  async refreshAll(): Promise<readonly AddonRecord[]> {
    await this.#load();
    await Promise.all(this.#records.map((record) => this.#refreshRecord(record)));
    return this.#records;
  }

  /** Refetches the manifests whose last refresh attempt is at least `maxAgeMs` old. */
  async refreshStale(maxAgeMs: number): Promise<void> {
    await this.#load();
    const now = this.#clock();
    await Promise.all(
      this.#records
        .filter((record) => now - record.lastAttemptAt >= maxAgeMs)
        .map((record) => this.#refreshRecord(record)),
    );
  }

  async #refreshRecord(record: AddonRecord): Promise<AddonRecord> {
    record.lastAttemptAt = this.#clock();
    let manifest: Manifest;
    try {
      manifest = await this.#fetchManifest(record.manifestUrl, this.#manifestOptions());
    } catch (err) {
      const code = errorCode(err);
      record.refreshError = { code, at: this.#clock() };
      this.#logger.warn(
        { addonId: record.id, host: record.host, code },
        'addon manifest refresh failed; keeping the last good manifest',
      );
      return record;
    }
    return this.#exclusive(async () => {
      // It may have been removed while the manifest was in flight.
      if (!this.#records.includes(record)) return record;
      const now = this.#clock();
      await this.#db
        .updateTable('addons')
        .set({ manifest_json: JSON.stringify(manifest), manifest_fetched_at: now })
        .where('id', '=', record.id)
        .execute();
      if (manifest.id !== record.manifest.id) {
        this.#logger.warn(
          { addonId: record.id, host: record.host, from: record.manifest.id, to: manifest.id },
          'addon manifest id changed on refresh',
        );
      }
      record.manifest = manifest;
      record.fetchedAt = now;
      record.refreshError = null;
      this.#changed(record.id);
      return record;
    });
  }

  #manifestOptions(): AddonRequestOptions {
    const options: AddonRequestOptions = { timeoutMs: this.#manifestTimeoutMs };
    if (this.#headers !== undefined) options.headers = this.#headers;
    if (this.#guard !== undefined) options.guard = this.#guard;
    return options;
  }

  async #fetchOrThrow(url: URL): Promise<Manifest> {
    try {
      return await this.#fetchManifest(url.href, this.#manifestOptions());
    } catch (err) {
      const code = errorCode(err);
      this.#logger.warn({ host: url.hostname, code }, 'addon manifest fetch failed');
      throw new AddonCollectionError(
        'manifest-unavailable',
        `The addon's manifest could not be fetched or is invalid (${code}).`,
        code,
      );
    }
  }

  #require(id: string): AddonRecord {
    const record = this.#records.find((r) => r.id === id);
    if (record === undefined) throw new AddonCollectionError('not-found', 'No addon with this id.');
    return record;
  }

  async #writePositions(records: readonly AddonRecord[]): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      for (const r of records) {
        await trx
          .updateTable('addons')
          .set({ position: r.position })
          .where('id', '=', r.id)
          .execute();
      }
    });
  }

  #changed(id: string | undefined): void {
    this.#index = undefined;
    if (id === undefined) return;
    for (const listener of this.#listeners) listener({ type: 'changed', id });
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#readAll().catch((err: unknown) => {
      this.#loaded = undefined;
      throw err;
    });
    return this.#loaded;
  }

  async #readAll(): Promise<void> {
    const rows = await this.#db
      .selectFrom('addons')
      .selectAll()
      .orderBy('position')
      .orderBy('created_at')
      .execute();
    const records: AddonRecord[] = [];
    for (const row of rows) {
      const parsed = ManifestSchema.safeParse(JSON.parse(row.manifest_json));
      let host = '';
      try {
        host = new URL(row.manifest_url).hostname;
      } catch {
        // Stored URLs were validated on add; an unparsable one keeps an empty host.
      }
      if (!parsed.success) {
        this.#logger.error({ addonId: row.id, host }, 'stored addon manifest is invalid; skipped');
        continue;
      }
      records.push({
        id: row.id,
        manifestUrl: row.manifest_url,
        host,
        enabled: row.enabled === 1,
        position: records.length,
        manifest: parsed.data,
        fetchedAt: row.manifest_fetched_at,
        createdAt: row.created_at,
        refreshError: null,
        lastAttemptAt: row.manifest_fetched_at,
      });
    }
    this.#records = records;
    this.#index = undefined;
  }
}
