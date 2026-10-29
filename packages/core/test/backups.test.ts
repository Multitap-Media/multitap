import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Backup } from '@multitap/api';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey, type ApiKeyScope } from '../src/auth/keys.ts';
import {
  BackupError,
  BackupService,
  PRE_MIGRATION_KEEP,
  backupBeforeMigrating,
  isBackupId,
  preMigrationDir,
} from '../src/backup/service.ts';
import { loadConfig } from '../src/config.ts';
import { Migrator } from 'kysely/migration';
import { migrateToLatest, migrationFiles, openDatabase, type Db } from '../src/db/index.ts';
import { startMultitap } from '../src/index.ts';
import { createApp } from '../src/http/app.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { manualClock, memoryLogger } from './helpers.ts';

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'multitap-backup-'));
  db = openDatabase(join(dir, 'multitap.sqlite'));
  await migrateToLatest(db);
});

afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

interface SetupOptions {
  keep?: number;
  intervalMs?: number;
  timers?: ConstructorParameters<typeof BackupService>[0]['timers'];
}

function setup(options: SetupOptions = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_BACKUP_DIR: join(dir, 'backups'),
    MULTITAP_BACKUP_KEEP: String(options.keep ?? 7),
    MULTITAP_BACKUP_INTERVAL_MS: String(options.intervalMs ?? 0),
  });
  const log = memoryLogger();
  const clock = manualClock();
  const metrics = new MetricsRegistry();
  const backups = new BackupService({
    db,
    logger: log.logger,
    clock,
    metrics,
    config,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams: new StreamStore({ clock }),
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics,
    backups,
  });
  const keyFor = async (scope: ApiKeyScope) =>
    (await createApiKey(db, { scope, label: `test ${scope}` }, clock)).key;
  const call = async (path: string, init: RequestInit = {}, scope: ApiKeyScope = 'admin') => {
    const key = await keyFor(scope);
    return app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${key}` },
    });
  };
  return { config, log, clock, metrics, backups, app, call, keyFor };
}

const backupPath = (id: string) => join(dir, 'backups', `${id}.sqlite`);

describe('BackupService', () => {
  it('writes a valid, openable copy with the same rows and no WAL sidecars', async () => {
    const { backups, clock } = setup();
    await createApiKey(db, { scope: 'client', label: 'one' }, clock);
    await createApiKey(db, { scope: 'admin', label: 'two' }, clock);
    const before = await db.selectFrom('api_keys').selectAll().orderBy('id').execute();

    const backup = await backups.run('manual');

    expect(backup.id).toMatch(/^multitap-\d{8}T\d{9}Z$/);
    expect(backup).toMatchObject({ kind: 'manual', createdAt: new Date(clock()).toISOString() });
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(readdirSync(join(dir, 'backups'))).toEqual([`${backup.id}.sqlite`]);

    const copy = new SQLite(backupPath(backup.id), { readonly: true });
    try {
      expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(copy.pragma('journal_mode')).toEqual([{ journal_mode: 'delete' }]);
      expect(copy.prepare('select * from api_keys order by id').all()).toEqual(before);
    } finally {
      copy.close();
    }
  });

  it('refuses a second backup while one runs', async () => {
    const { backups } = setup();
    const first = backups.run('manual');
    await expect(backups.run('manual')).rejects.toMatchObject({ code: 'busy' });
    await first;
    await expect(backups.run('manual')).resolves.toBeDefined();
  });

  it('keeps the newest MULTITAP_BACKUP_KEEP backups, scheduled and manual alike', async () => {
    const { backups, clock } = setup({ keep: 3 });
    const ids: string[] = [];
    for (const kind of ['manual', 'scheduled', 'manual', 'scheduled', 'manual'] as const) {
      ids.push((await backups.run(kind)).id);
      clock.advance(1000);
    }
    const left = await backups.list();
    expect(left.map((b) => b.id)).toEqual(ids.slice(2).reverse());
    expect(left.map((b) => b.kind)).toEqual(['manual', 'scheduled', 'manual']);
    expect(existsSync(backupPath(ids[0] ?? ''))).toBe(false);
  });

  it('lists newest first and ignores other files', async () => {
    const { backups, clock } = setup();
    const a = await backups.run('manual');
    clock.advance(5000);
    const b = await backups.run('scheduled');
    writeFileSync(join(dir, 'backups', 'notes.txt'), 'x');
    writeFileSync(join(dir, 'backups', 'multitap-bad.sqlite'), 'x');
    writeFileSync(join(dir, 'backups', `${a.id}.sqlite.partial`), 'x');
    expect((await backups.list()).map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('rejects ids that are not backup ids, so no path escapes the directory', async () => {
    const { backups } = setup();
    const real = await backups.run('manual');
    writeFileSync(join(dir, 'secret.sqlite'), 'outside');
    for (const id of [
      '../secret',
      '..\\secret',
      '../multitap',
      `${real.id}/../../secret`,
      `${real.id}.sqlite`,
      `${real.id}\u0000`,
      '/etc/passwd',
      'multitap-20260927T120000000Z/..',
      '',
    ]) {
      expect(isBackupId(id), id).toBe(false);
      expect(await backups.find(id), id).toBeUndefined();
      expect(await backups.delete(id), id).toBe(false);
    }
    expect(existsSync(join(dir, 'secret.sqlite'))).toBe(true);
    expect(isBackupId(real.id)).toBe(true);
    expect(isBackupId(`${real.id}-scheduled`)).toBe(true);
  });

  it('on failure logs a warning, counts it and leaves older backups intact', async () => {
    const { backups, config, log, metrics, clock } = setup();
    const older = await backups.run('manual');
    clock.advance(1000);
    // A file where the directory should be: mkdir fails.
    writeFileSync(join(dir, 'not-a-dir'), 'x');
    const good = config.backup.dir;
    (config.backup as { dir: string }).dir = join(dir, 'not-a-dir', 'sub');

    await expect(backups.run('scheduled')).rejects.toBeInstanceOf(BackupError);
    await expect(backups.run('scheduled')).rejects.toMatchObject({ code: 'failed' });

    (config.backup as { dir: string }).dir = good;
    expect((await backups.list()).map((b) => b.id)).toEqual([older.id]);
    expect(log.lines().some((l) => l.msg === 'backup failed' && l.level === 40)).toBe(true);
    const text = await metrics.metrics();
    expect(text).toContain('multitap_backup_outcomes_total{kind="scheduled",outcome="failure"} 2');
    expect(text).toContain('multitap_backup_outcomes_total{kind="manual",outcome="success"} 1');
  });

  it('is consistent when the database is written to during the backup', async () => {
    const { backups, clock } = setup();
    for (let i = 0; i < 200; i++) {
      await createApiKey(db, { scope: 'client', label: `seed ${String(i)}` }, clock);
    }
    const state = { writing: true };
    let written = 0;
    const writer = (async () => {
      while (state.writing) {
        await createApiKey(db, { scope: 'client', label: `load ${String(written)}` }, clock);
        written++;
        // Yield to the event loop, where the backup's steps run.
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const backup = await backups.run('manual');
    state.writing = false;
    await writer;

    const copy = new SQLite(backupPath(backup.id), { readonly: true });
    try {
      expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      const { n } = copy.prepare('select count(*) as n from api_keys').get() as { n: number };
      expect(n).toBeGreaterThanOrEqual(200);
      expect(n).toBeLessThanOrEqual(200 + written);
    } finally {
      copy.close();
    }
  });
});

describe('scheduled backups', () => {
  it('run from an injected timer, stop with Multitap, and are off at interval 0', async () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const timer = { unref: () => timer } as unknown as NodeJS.Timeout;
    const timers = {
      setInterval: (fn: () => void, ms: number) => {
        calls.push({ fn, ms });
        return timer;
      },
      clearInterval: (t: NodeJS.Timeout) => {
        cleared.push(t);
      },
    };

    const off = setup({ intervalMs: 0, timers });
    off.backups.start();
    expect(calls).toHaveLength(0);

    const { backups, log } = setup({ intervalMs: 3_600_000, timers });
    backups.start();
    backups.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(3_600_000);

    calls[0]?.fn();
    await backups.idle();
    const [first] = await backups.list();
    expect(first?.kind).toBe('scheduled');
    expect(log.lines().find((l) => l.msg === 'backup written')).toMatchObject({
      kind: 'scheduled',
      backupId: first?.id,
      sizeBytes: first?.sizeBytes,
    });

    backups.stop();
    expect(cleared).toEqual([timer]);
  });
});

describe('/v1/admin/backups', () => {
  it('creates, lists, downloads and deletes', async () => {
    const { call, clock } = setup();
    await createApiKey(db, { scope: 'client', label: 'x' }, clock);

    const created = await call('/v1/admin/backups', { method: 'POST' });
    expect(created.status).toBe(201);
    const backup = (await created.json()) as Backup;
    expect(backup).toMatchObject({ kind: 'manual' });

    const list = await call('/v1/admin/backups');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([backup]);

    const download = await call(`/v1/admin/backups/${backup.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="${backup.id}.sqlite"`,
    );
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(backup.sizeBytes);
    expect(bytes.equals(readFileSync(backupPath(backup.id)))).toBe(true);
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');

    const removed = await call(`/v1/admin/backups/${backup.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await call(`/v1/admin/backups/${backup.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/v1/admin/backups/${backup.id}`)).status).toBe(404);
    expect(await (await call('/v1/admin/backups')).json()).toEqual([]);
  });

  it('answers 409 to a backup requested while one runs', async () => {
    const { call } = setup();
    const [a, b] = await Promise.all([
      call('/v1/admin/backups', { method: 'POST' }),
      call('/v1/admin/backups', { method: 'POST' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.headers.get('content-type')).toContain('application/problem+json');
  });

  it('answers 500 and keeps older backups when a backup fails', async () => {
    const { call, config } = setup();
    expect((await call('/v1/admin/backups', { method: 'POST' })).status).toBe(201);
    const good = config.backup.dir;
    writeFileSync(join(dir, 'blocker'), 'x');
    (config.backup as { dir: string }).dir = join(dir, 'blocker', 'sub');
    expect((await call('/v1/admin/backups', { method: 'POST' })).status).toBe(500);
    (config.backup as { dir: string }).dir = good;
    expect(await (await call('/v1/admin/backups')).json()).toHaveLength(1);
  });

  it('rejects traversal in the id', async () => {
    const { call } = setup();
    await call('/v1/admin/backups', { method: 'POST' });
    writeFileSync(join(dir, 'secret.sqlite'), 'outside');
    for (const id of [
      '..%2Fsecret',
      '..%2F..%2Fsecret',
      '%2e%2e%2fsecret',
      '..%5Csecret',
      'multitap-20260927T120000000Z%2F..%2F..%2Fsecret',
      '..',
      'secret',
    ]) {
      for (const method of ['GET', 'DELETE']) {
        const res = await call(`/v1/admin/backups/${id}`, { method });
        expect([400, 404], `${method} ${id}`).toContain(res.status);
        expect(res.headers.get('content-type') ?? '').not.toContain('octet-stream');
      }
    }
    expect(existsSync(join(dir, 'secret.sqlite'))).toBe(true);
    // A well-formed id with no file is a plain 404.
    expect((await call('/v1/admin/backups/multitap-20200101T000000000Z')).status).toBe(404);
  });

  it('needs the admin scope', async () => {
    const { app, call } = setup();
    for (const [method, path] of [
      ['POST', '/v1/admin/backups'],
      ['GET', '/v1/admin/backups'],
      ['GET', '/v1/admin/backups/multitap-20200101T000000000Z'],
      ['DELETE', '/v1/admin/backups/multitap-20200101T000000000Z'],
    ] as const) {
      // A client key is valid but lacks the scope.
      expect((await call(path, { method }, 'client')).status).toBe(403);
      // No key, or an unknown one, looks like an unknown route.
      expect((await app.request(path, { method })).status).toBe(404);
      expect(
        (await app.request(path, { method, headers: { Authorization: 'Bearer nope' } })).status,
      ).toBe(404);
    }
  });

  it('exports the last success time and outcomes as metrics', async () => {
    const { call, metrics, clock } = setup();
    expect(await metrics.metrics()).not.toMatch(
      /^multitap_backup_last_success_timestamp_seconds [1-9]/m,
    );
    await call('/v1/admin/backups', { method: 'POST' });
    const text = await metrics.metrics();
    expect(text).toContain(
      `multitap_backup_last_success_timestamp_seconds ${String(Math.floor(clock() / 1000))}`,
    );
    expect(text).toContain('multitap_backup_outcomes_total{kind="manual",outcome="success"} 1');
  });
});

describe('backups before migrating', () => {
  /** A second database in `dir`, at 0010 (as before an upgrade that brings 0011), with one key. */
  async function databaseBeforeUpgrade(): Promise<{ dataDir: string; keyId: string }> {
    const dataDir = join(dir, 'upgrade');
    mkdirSync(dataDir);
    const old = openDatabase(join(dataDir, 'multitap.sqlite'));
    try {
      const { error } = await new Migrator({ db: old, provider: migrationFiles() }).migrateTo(
        '0010_session_subtitle_offsets',
      );
      if (error !== undefined) throw error as Error;
      const { id } = await createApiKey(old, { scope: 'admin', label: 'kept' }, manualClock());
      return { dataDir, keyId: id };
    } finally {
      await old.destroy();
    }
  }

  it('Multitap backs up an existing database before applying pending migrations', async () => {
    const { dataDir, keyId } = await databaseBeforeUpgrade();
    const { logger } = memoryLogger();
    const loaded = loadConfig({ NODE_ENV: 'test', MULTITAP_DATA_DIR: dataDir });
    const multitap = await startMultitap(
      { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } },
      logger,
    );
    await multitap.close();

    const folder = preMigrationDir(loaded.backup.dir);
    const files = readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^multitap-\d{8}T\d{9}Z-before-0011_item_player_states\.sqlite$/);
    const copy = new SQLite(join(folder, files[0] ?? ''), { readonly: true });
    try {
      expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      const names = (
        copy.prepare('select name from kysely_migration').all() as { name: string }[]
      ).map((r) => r.name);
      expect(names).toContain('0010_session_subtitle_offsets');
      expect(names).not.toContain('0011_item_player_states');
      expect(copy.prepare('select id from api_keys').all()).toEqual([{ id: keyId }]);
    } finally {
      copy.close();
    }
    // Kept apart from the API's backups and their rotation.
    expect(readdirSync(loaded.backup.dir).filter((n) => n.endsWith('.sqlite'))).toEqual([]);
  });

  it('takes none for a fresh database or when nothing is pending', async () => {
    const dataDir = join(dir, 'fresh');
    const { logger } = memoryLogger();
    const loaded = loadConfig({ NODE_ENV: 'test', MULTITAP_DATA_DIR: dataDir });
    const config = { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } };
    await (await startMultitap(config, logger)).close();
    await (await startMultitap(config, logger)).close();
    expect(existsSync(preMigrationDir(loaded.backup.dir))).toBe(false);
  });

  it(`keeps the newest ${String(PRE_MIGRATION_KEEP)}`, async () => {
    const { logger } = memoryLogger();
    const clock = manualClock();
    const backupDir = join(dir, 'backups');
    for (let i = 0; i < PRE_MIGRATION_KEEP + 2; i++) {
      await backupBeforeMigrating({ db, logger, clock, backupDir }, [`00${String(20 + i)}_next`]);
      clock.advance(1000);
    }
    const files = readdirSync(preMigrationDir(backupDir)).sort();
    expect(files).toHaveLength(PRE_MIGRATION_KEEP);
    expect(files[0]).toContain('before-0022_next');
  });

  it('a failed backup stops the upgrade before any migration runs', async () => {
    const { dataDir } = await databaseBeforeUpgrade();
    const { logger } = memoryLogger();
    // A file where the backup folder should go: mkdir fails.
    const blocked = join(dir, 'not-a-dir');
    writeFileSync(blocked, '');
    const upgrading = openDatabase(join(dataDir, 'multitap.sqlite'));
    try {
      await expect(
        migrateToLatest(upgrading, logger, {
          beforeMigrating: (pending) =>
            backupBeforeMigrating(
              { db: upgrading, logger, clock: manualClock(), backupDir: blocked },
              pending,
            ),
        }),
      ).rejects.toThrow(/before migrating failed/);
      const applied = await upgrading
        .selectFrom('kysely_migration' as never)
        .select('name' as never)
        .execute();
      expect(applied).not.toContainEqual({ name: '0011_item_player_states' });
    } finally {
      await upgrading.destroy();
    }
  });
});
