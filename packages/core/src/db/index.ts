import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import SQLite from 'better-sqlite3';
import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteDialect,
  SqliteDriver,
  sql,
  type DatabaseConnection,
  type Driver,
  type SqliteDialectConfig,
} from 'kysely';
import {
  FileMigrationProvider,
  Migrator,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration';
import type { Logger } from '../log.ts';
import type { Database } from './schema.ts';

export type { Database } from './schema.ts';
export type Db = Kysely<Database>;

/** File name of Multitap's database inside `MULTITAP_DATA_DIR`. */
export const DB_FILE = 'multitap.sqlite';

/**
 * Migrations are TypeScript files in packages/core/migrations, outside `src/`, and
 * are never compiled: Node's type stripping loads them as `.ts` both when Multitap
 * runs from `src/` and when it runs from `dist/`. `src/db/` and `dist/db/` are
 * the same depth below packages/core, so this path works from either; the Docker
 * image copies `migrations/` next to `dist/`.
 */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

/**
 * Opens (creating if needed) a SQLite database. Pass `':memory:'` for tests.
 * WAL mode, foreign keys on, and a busy timeout so the CLI and a running Multitap
 * can share the file.
 */
export function openDatabase(filename: string): Db {
  const sqlite = new SQLite(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  handles.set(db, sqlite);
  return db;
}

const handles = new WeakMap<Db, SQLite.Database>();

/**
 * The better-sqlite3 connection behind a database from {@link openDatabase},
 * for what Kysely doesn't expose (the online backup API).
 */
export function sqliteHandle(db: Db): SQLite.Database {
  const handle = handles.get(db);
  if (handle === undefined) throw new Error('not a database opened with openDatabase()');
  return handle;
}

export interface MigrateOptions {
  /**
   * Called with the pending migrations' names before any is applied, when the
   * database already has applied ones (a fresh database has nothing to keep).
   * Multitap and the CLI take a backup here (okf:architecture/core-persistence); a
   * throw stops the upgrade before it touches the database.
   */
  beforeMigrating?: (pending: readonly string[]) => Promise<void>;
  /** The migrations to apply: the files in {@link MIGRATIONS_DIR} by default (tests add their own). */
  provider?: MigrationProvider;
}

/** The migration files in {@link MIGRATIONS_DIR}. */
export function migrationFiles(): MigrationProvider {
  return new FileMigrationProvider({
    fs,
    path,
    migrationFolder: MIGRATIONS_DIR,
    // A file URL, since import() rejects bare Windows paths.
    import: (file: string) => import(pathToFileURL(file).href) as Promise<unknown>,
  });
}

/**
 * Applies every pending migration (okf:architecture/core-persistence). Throws
 * if one fails, and then nothing of this run is kept.
 *
 * - **Atomic.** Kysely's SQLite adapter runs migrations outside a transaction
 *   and records each only after it ran, so a crash or a full disk part-way
 *   would leave a half-applied, unrecorded migration that fails on every later
 *   start. Here the pending migrations and their `kysely_migration` rows run in
 *   one transaction (SQLite has transactional DDL).
 * - **Serialised.** That transaction starts with `BEGIN IMMEDIATE`, so Multitap and
 *   the CLI migrating the same file take turns (the second waits, then finds
 *   nothing pending) instead of racing.
 * - **Foreign keys off.** A table rebuild (create `_new`, copy, drop, rename,
 *   as 0005 does) cascade-deletes every child row while foreign keys are on,
 *   and `PRAGMA foreign_keys` can't change inside a transaction, so they are
 *   off for the run and `PRAGMA foreign_key_check` runs after each migration:
 *   a dangling reference fails that migration.
 */
export async function migrateToLatest(
  db: Db,
  logger?: Logger,
  options: MigrateOptions = {},
): Promise<void> {
  const handle = sqliteHandle(db);
  // Kysely opens its driver on first use and `destroy()` closes the connection
  // only if it was opened: use `db` once, so destroying it closes the file even
  // when every query so far went through the migration instance.
  await sql`select 1`.execute(db);
  const migrations = migrationsDb(handle);
  const provider = checkingForeignKeys(options.provider ?? migrationFiles());

  if (options.beforeMigrating !== undefined) {
    // Read outside the lock: if another runner migrates meanwhile, this run
    // finds nothing pending and the backup was merely one too many.
    const known = await new Migrator({ db: migrations, provider }).getMigrations();
    const pending = known.filter((m) => m.executedAt === undefined).map((m) => m.name);
    if (pending.length > 0 && pending.length < known.length) {
      await options.beforeMigrating(pending);
    }
  }

  handle.pragma('foreign_keys = OFF');
  let outcome: MigrationResultSet;
  try {
    outcome = await migrations.transaction().execute(async (trx) => {
      const result = await new Migrator({ db: trx, provider }).migrateToLatest();
      // The migrator reports a failure instead of throwing: throw it, so the
      // transaction rolls back rather than committing the migrations before it.
      if (result.error !== undefined) throw new RolledBack(result);
      return result;
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    outcome = err.result;
  } finally {
    handle.pragma('foreign_keys = ON');
  }
  const { error, results = [] } = outcome;
  for (const result of results) {
    if (result.status === 'Error') {
      logger?.error({ migration: result.migrationName }, 'migration failed');
    } else if (result.status === 'Success' && error === undefined) {
      // On an error the whole run rolled back, so nothing was applied.
      logger?.info({ migration: result.migrationName }, 'migration applied');
    }
  }
  if (error !== undefined) {
    throw new Error('database migration failed', { cause: error });
  }
}

class RolledBack extends Error {
  readonly result: MigrationResultSet;
  constructor(result: MigrationResultSet) {
    super('migrations rolled back');
    this.result = result;
  }
}

/** How long a runner waits for another to finish migrating the same file. */
const MIGRATION_LOCK_WAIT_MS = 60_000;
const MIGRATION_LOCK_RETRY_MS = 50;

/**
 * A second Kysely over the same connection, for migrating only. Its adapter
 * reports transactional DDL, which the migrator requires to be handed a
 * transaction, and its driver opens transactions with `BEGIN IMMEDIATE`, so the
 * write lock is held before the migrator reads which migrations are applied.
 * Never destroyed: that would close the shared connection.
 */
function migrationsDb(handle: SQLite.Database): Kysely<unknown> {
  return new Kysely<unknown>({ dialect: new MigrationDialect({ database: handle }, handle) });
}

class MigrationDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;
  readonly #handle: SQLite.Database;
  constructor(config: SqliteDialectConfig, handle: SQLite.Database) {
    super(config);
    this.#config = config;
    this.#handle = handle;
  }
  override createAdapter(): SqliteAdapter {
    return new TransactionalDdlAdapter();
  }
  override createDriver(): Driver {
    return new ImmediateDriver(this.#config, this.#handle);
  }
}

class TransactionalDdlAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

class ImmediateDriver extends SqliteDriver {
  readonly #handle: SQLite.Database;
  constructor(config: SqliteDialectConfig, handle: SQLite.Database) {
    super(config);
    this.#handle = handle;
  }

  /**
   * `BEGIN IMMEDIATE`, waiting for a runner that holds the lock. better-sqlite3
   * is synchronous, so the busy timeout would block the event loop, and a
   * second connection in the same process (tests) could never see the first
   * finish; the wait is an async retry with the busy timeout off instead.
   */
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    const busyTimeout = this.#handle.pragma('busy_timeout', { simple: true }) as number;
    this.#handle.pragma('busy_timeout = 0');
    const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
    try {
      for (;;) {
        try {
          await connection.executeQuery(CompiledQuery.raw('begin immediate'));
          return;
        } catch (err) {
          if ((err as { code?: unknown }).code !== 'SQLITE_BUSY' || Date.now() > deadline) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS));
        }
      }
    } finally {
      this.#handle.pragma(`busy_timeout = ${String(busyTimeout)}`);
    }
  }
}

/** Fails each migration that leaves a foreign key pointing nowhere. */
function checkingForeignKeys(provider: MigrationProvider): MigrationProvider {
  return {
    async getMigrations() {
      const migrations = await provider.getMigrations();
      return Object.fromEntries(
        Object.entries(migrations).map(([name, migration]) => [
          name,
          {
            ...migration,
            async up(db: Kysely<unknown>) {
              await migration.up(db);
              const { rows } = await sql<{
                table: string;
                parent: string;
              }>`pragma foreign_key_check`.execute(db);
              if (rows.length > 0) {
                const pairs = [...new Set(rows.map((r) => `${r.table} -> ${r.parent}`))];
                throw new Error(
                  `migration ${name} left ${String(rows.length)} broken foreign key(s): ${pairs.join(', ')}`,
                );
              }
            },
          },
        ]),
      );
    },
  };
}

/** True when the database answers a trivial query. */
export async function isDatabaseReachable(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
