/**
 * Engine descriptors as data (okf:concept/engine-descriptor, phase 1): stored in the
 * `engines` table and edited through `/v1/admin/engines`. Ranking reads the
 * capabilities; the API view adds `online`/`lastSeen` from the health checks
 * (health.ts) and `proxyPasswordSet`. Engine calls live in server-go.ts and
 * engine-module.ts.
 *
 * The proxy password is a secret column (okf:architecture/secrets-classes-and-engine-password): write-only through
 * {@link putEngine}, read only by {@link getEngineProxyPassword} as a
 * {@link Secret}, never part of a descriptor.
 */
import {
  EngineCapabilitiesSchema,
  type EngineDescriptor,
  type EngineInput,
  type EngineTransport,
} from '@multitap/api';
import { sql } from 'kysely';
import type { Db } from '../db/index.ts';
import type { ENGINE_PUBLIC_COLUMNS } from '../db/schema.ts';
import { Secret } from '../lib/secret.ts';
import type { Logger } from '../log.ts';

export interface EngineHealth {
  /** The last health check succeeded. False before the first check. */
  online: boolean;
  /** Unix ms of the last successful check, or null if never. */
  lastSeen: number | null;
  /** Undefined until the first check has finished. */
  checkedAt?: number;
}

/** What the HTTP layer needs to show `online` on engine descriptors. */
export interface EngineHealthView {
  health(engineId: string): EngineHealth | undefined;
}

interface EngineRow {
  id: string;
  name: string;
  transport: string;
  address: string | null;
  capabilities_json: string;
  local_addon: number;
}

function fromRow(row: EngineRow): EngineDescriptor {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as EngineTransport,
    address: row.address,
    // Stored rows were validated on write; parse anyway so a hand-edited row fails loudly.
    capabilities: EngineCapabilitiesSchema.parse(JSON.parse(row.capabilities_json)),
    localAddon: row.local_addon === 1,
  };
}

// A subset of ENGINE_PUBLIC_COLUMNS: never the proxy password.
const COLUMNS = [
  'id',
  'name',
  'transport',
  'address',
  'capabilities_json',
  'local_addon',
] as const satisfies readonly (typeof ENGINE_PUBLIC_COLUMNS)[number][];

export async function listEngines(db: Db): Promise<EngineDescriptor[]> {
  const rows = await db.selectFrom('engines').select(COLUMNS).orderBy('id').execute();
  return rows.map(fromRow);
}

export async function getEngine(db: Db, id: string): Promise<EngineDescriptor | undefined> {
  const row = await db
    .selectFrom('engines')
    .select(COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : fromRow(row);
}

/** The engine's proxy password (okf:architecture/secrets-classes-and-engine-password), or undefined when none is set or the engine is unknown. */
export async function getEngineProxyPassword(db: Db, id: string): Promise<Secret | undefined> {
  const row = await db
    .selectFrom('engines')
    .select('proxy_password')
    .where('id', '=', id)
    .executeTakeFirst();
  const value = row?.proxy_password;
  return value === null || value === undefined || value === '' ? undefined : new Secret(value);
}

/**
 * Creates or replaces an engine. Returns the stored descriptor and whether it
 * was new. `proxyPassword`: omitted keeps the stored one (none for a new
 * engine), `''` or null clears it.
 */
export async function putEngine(
  db: Db,
  id: string,
  input: EngineInput,
): Promise<{ engine: EngineDescriptor; created: boolean }> {
  const values: {
    name: string;
    transport: EngineTransport;
    address: string | null;
    capabilities_json: string;
    local_addon: number;
    proxy_password?: string | null;
  } = {
    name: input.name,
    transport: input.transport,
    address: input.address,
    capabilities_json: JSON.stringify(input.capabilities),
    local_addon: input.localAddon === true ? 1 : 0,
  };
  if (input.proxyPassword !== undefined) {
    values.proxy_password = input.proxyPassword === '' ? null : input.proxyPassword;
  }
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('engines')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (existing === undefined) {
      await trx
        .insertInto('engines')
        .values({ id, ...values, last_seen: null })
        .execute();
    } else {
      await trx.updateTable('engines').set(values).where('id', '=', id).execute();
    }
    const engine: EngineDescriptor = {
      id,
      name: input.name,
      transport: input.transport,
      address: input.address,
      capabilities: input.capabilities,
      localAddon: input.localAddon === true,
    };
    return { engine, created: existing === undefined };
  });
}

/** Deletes an engine. False if there was none. */
export async function deleteEngine(db: Db, id: string): Promise<boolean> {
  const result = await db.deleteFrom('engines').where('id', '=', id).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** A request names no engine, and there is no default to use (see {@link defaultEngineId}). */
export class NoDefaultEngineError extends Error {}

const NO_ENGINE = 'No engine is configured yet: an admin adds one with PUT /v1/admin/engines/{id}.';
const NO_DEFAULT =
  'Several engines are configured and none is the default: name one with `engine`, or set MULTITAP_SELECTION_DEFAULT_ENGINE.';

/**
 * The engine a request that names none uses: `MULTITAP_SELECTION_DEFAULT_ENGINE` when
 * set, else the only engine there is. Multitap seeds no engine, so a fresh install
 * has none until an admin adds one.
 *
 * @throws {NoDefaultEngineError} no engine yet, or several and no default set.
 */
export async function defaultEngineId(db: Db, configured: string | undefined): Promise<string> {
  if (configured !== undefined) return configured;
  const [only, another] = await db.selectFrom('engines').select('id').limit(2).execute();
  if (only === undefined) throw new NoDefaultEngineError(NO_ENGINE);
  if (another !== undefined) throw new NoDefaultEngineError(NO_DEFAULT);
  return only.id;
}

/** Warns at startup when requests without `engine` can't play: no engine, an unknown default, or no default among several. */
export async function checkEngines(
  db: Db,
  configured: string | undefined,
  logger: Logger,
): Promise<void> {
  const ids = (await db.selectFrom('engines').select('id').execute()).map((row) => row.id);
  if (ids.length === 0) {
    logger.warn(
      `no engine configured; source lists and sessions fail until one is added (PUT /v1/admin/engines/{id})`,
    );
  } else if (configured !== undefined && !ids.includes(configured)) {
    logger.warn(
      { engineId: configured },
      'MULTITAP_SELECTION_DEFAULT_ENGINE names an engine that does not exist',
    );
  } else if (configured === undefined && ids.length > 1) {
    logger.warn(
      { engines: ids },
      'several engines and no MULTITAP_SELECTION_DEFAULT_ENGINE; requests must name one',
    );
  }
}

/** A descriptor as the API shows it: plus `online` (health checks), `lastSeen` and `proxyPasswordSet`. */
async function withHealth(
  db: Db,
  engines: EngineDescriptor[],
  health: EngineHealthView | undefined,
): Promise<EngineDescriptor[]> {
  if (engines.length === 0) return engines;
  const rows = await db
    .selectFrom('engines')
    .select([
      'id',
      'last_seen',
      // Only whether one is set; the password itself never leaves the database here.
      sql<number>`proxy_password is not null and proxy_password != ''`.as('proxy_password_set'),
    ])
    .where(
      'id',
      'in',
      engines.map((e) => e.id),
    )
    .execute();
  const stored = new Map(rows.map((r) => [r.id, r]));
  return engines.map((engine) => {
    const h = health?.health(engine.id);
    const row = stored.get(engine.id);
    const lastSeen = h?.lastSeen ?? row?.last_seen ?? null;
    return {
      ...engine,
      online: h?.online ?? false,
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      proxyPasswordSet: row?.proxy_password_set === 1,
    };
  });
}

/** {@link listEngines} with `online` and `lastSeen`, for `/v1/admin/engines`. */
export async function listEngineViews(
  db: Db,
  health?: EngineHealthView,
): Promise<EngineDescriptor[]> {
  return withHealth(db, await listEngines(db), health);
}

/** {@link getEngine} with `online` and `lastSeen`. */
export async function getEngineView(
  db: Db,
  id: string,
  health?: EngineHealthView,
): Promise<EngineDescriptor | undefined> {
  const engine = await getEngine(db, id);
  return engine === undefined ? undefined : (await withHealth(db, [engine], health))[0];
}
