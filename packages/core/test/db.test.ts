import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_FILE, migrateToLatest, openDatabase, type Db } from '../src/db/index.ts';
import { tempDir } from './helpers.ts';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function freshFileDb(): Db {
  const tmp = tempDir();
  const db = openDatabase(join(tmp.dir, DB_FILE));
  cleanup = async () => {
    await db.destroy();
    tmp.cleanup();
  };
  return db;
}

async function columns(db: Db, table: string) {
  const { rows } = await sql<{
    name: string;
    notnull: number;
    pk: number;
  }>`select name, "notnull", pk from pragma_table_info(${table})`.execute(db);
  return Object.fromEntries(
    rows.map((r) => [r.name, { notNull: r.notnull === 1, pk: r.pk === 1 }]),
  );
}

describe('database', () => {
  it('opens in WAL mode with foreign keys on', async () => {
    const db = freshFileDb();
    const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db);
    const fk = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(db);
    expect(mode.rows[0]?.journal_mode).toBe('wal');
    expect(fk.rows[0]?.foreign_keys).toBe(1);
  });

  it('applies the migrations to a fresh database, and re-running is a no-op', async () => {
    const db = freshFileDb();
    await migrateToLatest(db);
    await migrateToLatest(db);

    const { rows } = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'
      order by name`.execute(db);
    expect(rows.map((r) => r.name)).toEqual([
      'addons',
      'api_keys',
      'engine_sessions',
      'engines',
      'item_player_states',
      'last_sources',
      'library_items',
      'playback_sessions',
      'profiles',
      'session_subtitle_offsets',
      'settings',
      'token_revocations',
    ]);

    const applied = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
    expect(applied.rows.map((r) => r.name)).toEqual([
      '0001_initial',
      '0002_engine_local_addon',
      '0003_sessions_library_settings',
      '0004_home_engine_phase0',
      '0005_api_key_metrics_scope',
      '0006_engine_proxy_password',
      '0007_engine_session_release_retry',
      '0008_session_tracks_binge',
      '0009_profile_settings_last_source',
      '0010_session_subtitle_offsets',
      '0011_item_player_states',
    ]);

    expect(await columns(db, 'addons')).toEqual({
      id: { notNull: true, pk: true },
      manifest_url: { notNull: true, pk: false },
      enabled: { notNull: true, pk: false },
      position: { notNull: true, pk: false },
      manifest_json: { notNull: true, pk: false },
      manifest_fetched_at: { notNull: true, pk: false },
      created_at: { notNull: true, pk: false },
    });
    expect(await columns(db, 'engines')).toEqual({
      id: { notNull: true, pk: true },
      name: { notNull: true, pk: false },
      transport: { notNull: true, pk: false },
      address: { notNull: false, pk: false },
      capabilities_json: { notNull: true, pk: false },
      last_seen: { notNull: false, pk: false },
      local_addon: { notNull: true, pk: false },
      proxy_password: { notNull: false, pk: false },
    });
    expect(await columns(db, 'api_keys')).toEqual({
      id: { notNull: true, pk: true },
      key_hash: { notNull: true, pk: false },
      scope: { notNull: true, pk: false },
      label: { notNull: true, pk: false },
      created_at: { notNull: true, pk: false },
      last_used: { notNull: false, pk: false },
      revoked_at: { notNull: false, pk: false },
    });
  });

  it('enforces the api_keys scope check and unique hashes', async () => {
    const db = freshFileDb();
    await migrateToLatest(db);
    const row = {
      id: 'a',
      key_hash: 'h',
      scope: 'client' as const,
      label: 'l',
      created_at: 1,
      last_used: null,
      revoked_at: null,
    };
    await db.insertInto('api_keys').values(row).execute();
    await expect(
      db
        .insertInto('api_keys')
        .values({ ...row, id: 'b' })
        .execute(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      db
        .insertInto('api_keys')
        .values({ ...row, id: 'c', key_hash: 'h2', scope: 'root' as 'admin' })
        .execute(),
    ).rejects.toThrow(/CHECK/);
  });
});
