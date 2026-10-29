/**
 * Review PoC: backups are named, ordered and pruned by the wall-clock stamp in
 * their id. After the clock steps back (NTP correction, an RTC reset on a mini
 * PC, a VM restore), a new backup sorts as the oldest, and the prune that runs
 * right after writing it deletes it at once; run() still resolves (the API
 * answers 201 with an id that 404s), while backups from the "future" are kept.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../../../src/backup/service.ts';
import { loadConfig } from '../../../src/config.ts';
import { migrateToLatest, openDatabase, type Db } from '../../../src/db/index.ts';
import { MetricsRegistry } from '../../../src/metrics/index.ts';
import { manualClock, memoryLogger } from '../../helpers.ts';

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'multitap-review-backup-'));
  db = openDatabase(join(dir, 'multitap.sqlite'));
  await migrateToLatest(db);
});

afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('backups (review PoC)', () => {
  it.fails('a backup written after the clock stepped back is kept', async () => {
    const clock = manualClock();
    const backups = new BackupService({
      db,
      logger: memoryLogger().logger,
      clock,
      metrics: new MetricsRegistry(),
      config: loadConfig({
        NODE_ENV: 'test',
        MULTITAP_BACKUP_DIR: join(dir, 'backups'),
        MULTITAP_BACKUP_KEEP: '2',
      }),
    });
    await backups.run('scheduled');
    clock.advance(1000);
    await backups.run('scheduled');

    clock.advance(-3_600_000); // the clock is corrected an hour back
    const latest = await backups.run('manual');

    // Expected: the backup just written (the newest data) survives the prune.
    expect(existsSync(join(dir, 'backups', `${latest.id}.sqlite`))).toBe(true);
    expect((await backups.find(latest.id))?.backup.id).toBe(latest.id);
  });
});
