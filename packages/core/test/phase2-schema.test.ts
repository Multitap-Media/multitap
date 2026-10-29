import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlaybackSessionSchema, MediaTokenSchema, LibraryItemSchema } from '@multitap/api';
import { sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrateToLatest, openDatabase, type Db } from '../src/db/index.ts';
import {
  ENGINE_PUBLIC_COLUMNS,
  ENGINE_SESSION_PUBLIC_COLUMNS,
  PLAYBACK_SESSION_PUBLIC_COLUMNS,
  SECRET_COLUMNS,
} from '../src/db/schema.ts';
import { listEngines } from '../src/engines/index.ts';
import { HOME_ENGINE, addHomeEngine } from './engine-fixture.ts';
import { REDACT_CENSOR } from '../src/log.ts';
import { memoryLogger, migratedMemoryDb } from './helpers.ts';

// Fake values only.
const FAKE_KEY = 'FAKEdebridKEY0123456789abcdef';
const FAKE_STREAM = { url: `https://cdn.example.invalid/${FAKE_KEY}/video.mkv`, name: 'x' };
const FAKE_MEDIA_URL = `https://cdn.example.invalid/${FAKE_KEY}/video.mkv`;

async function columnNames(db: Db, table: string): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`select name from pragma_table_info(${table})`.execute(db);
  return rows.map((r) => r.name).sort();
}

function migrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_DIR,
      import: (file: string) => import(pathToFileURL(file).href) as Promise<unknown>,
    }),
  });
}

async function insertSession(db: Db) {
  await db
    .insertInto('playback_sessions')
    .values({
      id: 'ps_1',
      key: 'room:abc',
      item_type: 'movie',
      item_id: 'tt1375666',
      video_id: null,
      source_json: '{"key":"k1"}',
      identity: 'id-hash',
      candidates_json: null,
      chosen_key: 'k1',
      stream_json: JSON.stringify(FAKE_STREAM),
      engine_id: 'home',
      sid: 'AAAAAAAAAAAAAAAAAAAAAA',
      delivery: 'transcode',
      mode: 'play',
      high_res: 'off',
      requested_quality_json: null,
      quality_json: null,
      ready_by: null,
      retain_until: null,
      status: 'ready',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      last_access: 1,
      released_at: null,
    })
    .execute();
  await db
    .insertInto('engine_sessions')
    .values({
      sid: 'AAAAAAAAAAAAAAAAAAAAAA',
      engine_id: 'home',
      session_key: 'ps_1',
      stream_hash: 'h',
      applied_quality_json: null,
      media_url: FAKE_MEDIA_URL,
      created_at: 1,
      last_used: 1,
    })
    .execute();
}

describe('secret columns', () => {
  it('the public column lists are every column but the secret ones', async () => {
    const db = await migratedMemoryDb();
    expect(
      [...PLAYBACK_SESSION_PUBLIC_COLUMNS, ...SECRET_COLUMNS.playback_sessions].sort(),
    ).toEqual(await columnNames(db, 'playback_sessions'));
    expect([...ENGINE_PUBLIC_COLUMNS, ...SECRET_COLUMNS.engines].sort()).toEqual(
      await columnNames(db, 'engines'),
    );
    expect([...ENGINE_SESSION_PUBLIC_COLUMNS, ...SECRET_COLUMNS.engine_sessions].sort()).toEqual(
      await columnNames(db, 'engine_sessions'),
    );
    await db.destroy();
  });

  it('never reach an API view: the schemas have no such fields and strip them', async () => {
    const db = await migratedMemoryDb();
    await insertSession(db);
    const row = await db
      .selectFrom('playback_sessions')
      .select(PLAYBACK_SESSION_PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    const engineRow = await db
      .selectFrom('engine_sessions')
      .select(ENGINE_SESSION_PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(engineRow)).not.toContain(FAKE_KEY);

    const secretish = /stream|mediaur|media_url|manifest/i;
    for (const schema of [PlaybackSessionSchema, MediaTokenSchema, LibraryItemSchema]) {
      for (const key of Object.keys(schema.shape)) {
        if (key === 'mediaUrl') continue; // the public media URL of a token, not the engine's
        expect(key, `${schema.description ?? ''} ${key}`).not.toMatch(secretish);
      }
    }
    // A view built by spreading a full row still loses them when validated.
    const parsed = PlaybackSessionSchema.safeParse({
      id: 'ps_1',
      item: { type: 'movie', id: 'tt1375666' },
      source: { key: 'k1' },
      delivery: 'transcode',
      mediaEntry: 'master.m3u8',
      mode: 'play',
      highRes: 'off',
      status: 'ready',
      tokenEpoch: 0,
      createdAt: '2026-09-30T20:00:00.000Z',
      lastAccess: '2026-09-30T20:00:00.000Z',
      stream_json: JSON.stringify(FAKE_STREAM),
      stream: FAKE_STREAM,
      mediaURL: FAKE_MEDIA_URL,
    });
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.data)).not.toContain(FAKE_KEY);
    await db.destroy();
  });

  it('are redacted when a full row is logged at info', async () => {
    const db = await migratedMemoryDb();
    await insertSession(db);
    const session = await db.selectFrom('playback_sessions').selectAll().executeTakeFirstOrThrow();
    const engine = await db.selectFrom('engine_sessions').selectAll().executeTakeFirstOrThrow();
    const { logger, text, lines } = memoryLogger('info');
    logger.info({ session, engine }, 'rows');
    logger.flush();
    expect(text()).not.toContain(FAKE_KEY);
    expect(lines()[0]).toMatchObject({
      session: { id: 'ps_1', stream_json: REDACT_CENSOR },
      engine: { sid: 'AAAAAAAAAAAAAAAAAAAAAA', media_url: REDACT_CENSOR },
    });
    await db.destroy();
  });
});

describe('phase 2 tables', () => {
  it('cascade token revocations and library items with their parent', async () => {
    const db = await migratedMemoryDb();
    await insertSession(db);
    await db
      .insertInto('token_revocations')
      .values({ session_id: 'ps_1', subject: 'm1', until: 5 })
      .execute();
    await db.insertInto('profiles').values({ id: 'pr_1', name: 'P', created_at: 1 }).execute();
    await db
      .insertInto('library_items')
      .values({
        profile_id: 'pr_1',
        item_id: 'tt1',
        type: 'movie',
        name: 'M',
        poster: null,
        state_json: '{}',
        behavior_hints_json: '{}',
        ctime: 1,
        mtime: 1,
      })
      .execute();
    await db.deleteFrom('playback_sessions').where('id', '=', 'ps_1').execute();
    await db.deleteFrom('profiles').where('id', '=', 'pr_1').execute();
    expect(await db.selectFrom('token_revocations').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('library_items').selectAll().execute()).toEqual([]);
    await db.destroy();
  });

  it('checks session enums and the engine session lookup key', async () => {
    const db = await migratedMemoryDb();
    await insertSession(db);
    await expect(
      db
        .updateTable('playback_sessions')
        .set({ status: 'done' as 'ready' })
        .execute(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db
        .insertInto('engine_sessions')
        .values({
          sid: 'BBBBBBBBBBBBBBBBBBBBBB',
          engine_id: 'home',
          session_key: 'ps_1',
          stream_hash: 'h',
          applied_quality_json: null,
          media_url: 'x',
          created_at: 1,
          last_used: 1,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/);
    await db.destroy();
  });
});

describe('home seed migration (0004)', () => {
  const OLD_SEED = {
    hwaccel: 'qsv',
    liveMaxHeight: 1080,
    preparedMaxHeight: 2160,
    tonemap: false,
    liveConcurrency: 3,
    prepareConcurrency: 1,
  };

  async function before0004(rows: { id: string; capabilities: object }[]): Promise<Db> {
    const db = openDatabase(':memory:');
    const result = await migrator(db).migrateTo('0003_sessions_library_settings');
    expect(result.error).toBeUndefined();
    for (const row of rows) {
      await db
        .insertInto('engines')
        .values({
          id: row.id,
          name: row.id,
          transport: 'lan',
          address: null,
          capabilities_json: JSON.stringify(row.capabilities),
          last_seen: null,
        })
        .execute();
    }
    return db;
  }

  it('updates home when it still holds the old seed', async () => {
    const db = await before0004([{ id: 'home', capabilities: OLD_SEED }]);
    await migrateToLatest(db);
    expect((await listEngines(db))[0]?.capabilities).toEqual(HOME_ENGINE.capabilities);
    await db.destroy();
  });

  it("keeps an operator's edits, adding only sessionOverrides: false", async () => {
    const edited = { ...OLD_SEED, liveConcurrency: 1 };
    const db = await before0004([
      { id: 'home', capabilities: edited },
      { id: 'alex-pc', capabilities: { ...OLD_SEED, hwaccel: 'nvenc' } },
    ]);
    await migrateToLatest(db);
    const engines = await listEngines(db);
    expect(engines.find((e) => e.id === 'home')?.capabilities).toEqual({
      ...edited,
      sessionOverrides: false,
    });
    expect(engines.find((e) => e.id === 'alex-pc')?.capabilities).toEqual({
      ...OLD_SEED,
      hwaccel: 'nvenc',
      sessionOverrides: false,
    });
    await db.destroy();
  });

  it('leaves a fresh database to the seed', async () => {
    const db = await migratedMemoryDb();
    await addHomeEngine(db);
    expect(await listEngines(db)).toEqual([HOME_ENGINE]);
    await db.destroy();
  });
});
