/**
 * How migrations are applied (okf:architecture/core-persistence): atomically,
 * one runner at a time, with foreign keys off for table rebuilds. These began
 * as PoCs of the adversarial review (okf:core-review/bugs-library-migrations-not-atomic,
 * okf:core-review/design-api-migration-safety).
 */
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DB_FILE,
  migrateToLatest,
  migrationFiles,
  openDatabase,
  sqliteHandle,
  type Db,
} from '../src/db/index.ts';
import { tempDir } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function fileDb(): Db {
  const tmp = tempDir();
  const db = openDatabase(join(tmp.dir, DB_FILE));
  cleanups.push(async () => {
    await db.destroy();
    tmp.cleanup();
  });
  return db;
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const { rows } = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name = ${name}`.execute(db);
  return rows.length === 1;
}

async function applied(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
  return rows.map((r) => r.name);
}

/** The real migrations plus `extra`. */
function withExtra(extra: Record<string, Migration>): MigrationProvider {
  const files = migrationFiles();
  return {
    async getMigrations() {
      return { ...(await files.getMigrations()), ...extra };
    },
  };
}

/**
 * A database at 0002 with room for only a few more pages (a nearly full disk,
 * simulated with `PRAGMA max_page_count`; a crash or a killed container cuts a
 * migration short the same way).
 */
async function nearlyFullAt0002(): Promise<Db> {
  const db = fileDb();
  const { error } = await new Migrator({ db, provider: migrationFiles() }).migrateTo(
    '0002_engine_local_addon',
  );
  if (error !== undefined) throw error as Error;
  const handle = sqliteHandle(db);
  const pages = handle.pragma('page_count', { simple: true }) as number;
  handle.pragma(`max_page_count = ${String(pages + 4)}`);
  return db;
}

// A migration that rebuilds `profiles` the way 0005 rebuilt `api_keys` (SQLite
// can't alter a CHECK or a column type): create _new, copy, drop, rename.
// `profiles` is the parent of library_items, last_sources and item_player_states.
const rebuildProfiles: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`CREATE TABLE profiles_new (id text primary key, name text not null, created_at integer not null, settings_json text) strict`.execute(
      db,
    );
    await sql`INSERT INTO profiles_new SELECT id, name, created_at, settings_json FROM profiles`.execute(
      db,
    );
    await db.schema.dropTable('profiles').execute();
    await sql`ALTER TABLE profiles_new RENAME TO profiles`.execute(db);
  },
};

async function seedLibraryItem(db: Db): Promise<void> {
  await sql`INSERT INTO profiles (id, name, created_at) VALUES ('p1', 'Me', 0)`.execute(db);
  await sql`INSERT INTO library_items (profile_id, item_id, type, name, state_json, behavior_hints_json, mtime)
            VALUES ('p1', 'tt0000001', 'movie', 'A film', '{}', '{}', 0)`.execute(db);
}

async function libraryItemCount(db: Db): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM library_items`.execute(db);
  return rows[0]?.n ?? -1;
}

describe('migrations', () => {
  it('a migration cut short by a full disk leaves no trace of itself', async () => {
    const db = await nearlyFullAt0002();
    await expect(migrateToLatest(db)).rejects.toThrow(/migration failed/);
    expect(await applied(db)).not.toContain('0003_sessions_library_settings');
    // 0003's first CREATE TABLE rolled back with the rest of the run.
    expect(await tableExists(db, 'playback_sessions')).toBe(false);
  });

  it('once the disk has room again, the next start completes the migrations', async () => {
    const db = await nearlyFullAt0002();
    await expect(migrateToLatest(db)).rejects.toThrow(/migration failed/);
    // The operator frees space and restarts Multitap.
    sqliteHandle(db).pragma('max_page_count = 1073741823');
    await expect(migrateToLatest(db)).resolves.toBeUndefined();
    expect(await applied(db)).toContain('0011_item_player_states');
  });

  it('two connections migrating the same file at once both succeed', async () => {
    const tmp = tempDir();
    const file = join(tmp.dir, DB_FILE);
    const multitap = openDatabase(file);
    const cli = openDatabase(file);
    cleanups.push(async () => {
      await multitap.destroy();
      await cli.destroy();
      tmp.cleanup();
    });
    const results = await Promise.allSettled([migrateToLatest(multitap), migrateToLatest(cli)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await applied(multitap)).toContain('0011_item_player_states');
  });

  it('keeps library rows when a later migration rebuilds profiles like 0005 did', async () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);
    await seedLibraryItem(db);

    await migrateToLatest(db, undefined, {
      provider: withExtra({ '9999_rebuild_profiles': rebuildProfiles }),
    });

    expect(await libraryItemCount(db)).toBe(1);
    // Foreign keys are back on once the run is over.
    expect(sqliteHandle(db).pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('fails and rolls back a migration that leaves a dangling foreign key', async () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);
    await seedLibraryItem(db);
    const dropProfiles: Migration = {
      async up(trx: Kysely<unknown>) {
        await sql`DELETE FROM profiles`.execute(trx);
      },
    };

    await expect(
      migrateToLatest(db, undefined, {
        provider: withExtra({ '9999_drop_profiles': dropProfiles }),
      }),
    ).rejects.toThrow(/migration failed/);

    expect(await applied(db)).not.toContain('9999_drop_profiles');
    expect(await libraryItemCount(db)).toBe(1);
    const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM profiles`.execute(db);
    expect(rows[0]?.n).toBe(1);
  });

  it('calls beforeMigrating with the pending migrations, only for an existing database', async () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.destroy());
    const calls: (readonly string[])[] = [];
    const beforeMigrating = (pending: readonly string[]) => {
      calls.push(pending);
      return Promise.resolve();
    };
    // A fresh database has nothing to back up.
    await migrateToLatest(db, undefined, { beforeMigrating });
    expect(calls).toEqual([]);
    // Nothing pending: no call.
    await migrateToLatest(db, undefined, { beforeMigrating });
    expect(calls).toEqual([]);

    const noop: Migration = { up: () => Promise.resolve() };
    await migrateToLatest(db, undefined, {
      beforeMigrating,
      provider: withExtra({ '9999_noop': noop }),
    });
    expect(calls).toEqual([['9999_noop']]);
  });

  it('a throwing beforeMigrating stops the upgrade before any migration runs', async () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);
    const noop: Migration = { up: () => Promise.resolve() };
    await expect(
      migrateToLatest(db, undefined, {
        beforeMigrating: () => Promise.reject(new Error('no backup')),
        provider: withExtra({ '9999_noop': noop }),
      }),
    ).rejects.toThrow('no backup');
    expect(await applied(db)).not.toContain('9999_noop');
  });
});
