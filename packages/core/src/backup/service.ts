import { closeSync, openSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { BACKUP_ID_PATTERN, type Backup, type BackupKind } from '@multitap/api';
import type { Clock } from '../auth/keys.ts';
import type { Db } from '../db/index.ts';
import { sqliteHandle } from '../db/index.ts';
import type { Logger } from '../log.ts';
import type { MetricsRegistry } from '../metrics/index.ts';

/**
 * Database backups (okf:architecture/core-persistence). SQLite runs in WAL mode, so copying
 * the file of a live database is unsafe; a backup uses SQLite's online backup
 * API (better-sqlite3's `backup()`), which copies a consistent snapshot in
 * steps while Multitap keeps serving, then converts the copy to a single
 * self-contained file and checks it with `PRAGMA integrity_check`.
 *
 * A backup holds secrets (engine proxy passwords, stored raw streams, hashed
 * API keys): it is written with mode 0600 in a 0700 directory where the
 * platform has modes, and logs name only its id and size.
 */

const ID_PATTERN = new RegExp(BACKUP_ID_PATTERN);
const PREFIX = 'multitap-';
const SUFFIX = '.sqlite';
const PARTIAL = '.partial';
const SCHEDULED_TAG = '-scheduled';

export type BackupErrorCode = 'busy' | 'failed';

export class BackupError extends Error {
  override name = 'BackupError';
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface BackupServiceDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  metrics: MetricsRegistry;
  config: { backup: { dir: string; intervalMs: number; keep: number } };
  /** Timer functions, injectable like the clock so tests can drive the schedule. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearInterval: (timer: NodeJS.Timeout) => void;
  };
}

/** `20260930T203015123Z`, from a Unix time in ms. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/** The Unix time in ms an id's timestamp names. */
function stampToMs(id: string): number {
  const p = (from: number, to: number) => id.slice(PREFIX.length + from, PREFIX.length + to);
  return Date.parse(
    `${p(0, 4)}-${p(4, 6)}-${p(6, 8)}T${p(9, 11)}:${p(11, 13)}:${p(13, 15)}.${p(15, 18)}Z`,
  );
}

export function isBackupId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export class BackupService {
  readonly #o: BackupServiceDeps;
  #running: Promise<Backup> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: BackupServiceDeps) {
    this.#o = deps;
  }

  get #dir(): string {
    return this.#o.config.backup.dir;
  }

  /** Starts the schedule when `MULTITAP_BACKUP_INTERVAL_MS` is set. */
  start(): void {
    const { intervalMs } = this.#o.config.backup;
    if (intervalMs <= 0 || this.#timer !== undefined) return;
    const timers = this.#o.timers ?? { setInterval, clearInterval };
    this.#timer = timers.setInterval(() => {
      this.run('scheduled').catch((err: unknown) => {
        // A manual backup still running is fine: skip this tick. Failures
        // were already logged and counted by run().
        if (err instanceof BackupError && err.code === 'busy') {
          this.#o.logger.debug('scheduled backup skipped: one is already running');
        }
      });
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) (this.#o.timers?.clearInterval ?? clearInterval)(this.#timer);
    this.#timer = undefined;
  }

  /** Resolves when a backup in flight has finished (successfully or not). */
  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** The backups, newest first. */
  async list(): Promise<Backup[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.#dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const found: Backup[] = [];
    for (const name of names) {
      if (!name.endsWith(SUFFIX)) continue;
      const id = name.slice(0, -SUFFIX.length);
      if (!isBackupId(id)) continue;
      try {
        const stat = await fs.stat(join(this.#dir, name));
        if (stat.isFile()) found.push(toBackup(id, stat.size));
      } catch {
        // Deleted while listing.
      }
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** The backup's file path and description, or `undefined` for an unknown or malformed id. */
  async find(id: string): Promise<{ backup: Backup; path: string } | undefined> {
    if (!isBackupId(id)) return undefined;
    const path = join(this.#dir, `${id}${SUFFIX}`);
    try {
      const stat = await fs.stat(path);
      return stat.isFile() ? { backup: toBackup(id, stat.size), path } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Deletes a backup; false when there is none with this id. */
  async delete(id: string): Promise<boolean> {
    const found = await this.find(id);
    if (found === undefined) return false;
    await fs.rm(found.path, { force: true });
    this.#o.logger.info({ backupId: id }, 'backup deleted');
    return true;
  }

  /**
   * Writes, verifies and prunes one backup.
   *
   * @throws {BackupError} `busy` when one is already running, `failed` otherwise
   *   (older backups are left alone).
   */
  run(kind: BackupKind): Promise<Backup> {
    if (this.#running !== undefined) {
      return Promise.reject(new BackupError('busy', 'A backup is already running.'));
    }
    const job = this.#backup(kind).finally(() => {
      this.#running = undefined;
    });
    this.#running = job;
    return job;
  }

  async #backup(kind: BackupKind): Promise<Backup> {
    const { logger, metrics, clock } = this.#o;
    const id = `${PREFIX}${stamp(clock())}${kind === 'scheduled' ? SCHEDULED_TAG : ''}`;
    try {
      const size = await writeSnapshot(this.#o.db, this.#dir, `${id}${SUFFIX}`);
      metrics.recordBackup(kind, true, clock());
      logger.info({ backupId: id, kind, sizeBytes: size }, 'backup written');
      await this.#prune();
      return toBackup(id, size);
    } catch (err) {
      metrics.recordBackup(kind, false, clock());
      logger.warn({ backupId: id, kind, err: describe(err) }, 'backup failed');
      throw new BackupError('failed', 'The backup failed.', { cause: err });
    }
  }

  /** Removes the oldest backups beyond `MULTITAP_BACKUP_KEEP`; a failure only warns. */
  async #prune(): Promise<void> {
    try {
      const doomed = (await this.list()).slice(this.#o.config.backup.keep);
      for (const backup of doomed) {
        await fs.rm(join(this.#dir, `${backup.id}${SUFFIX}`), { force: true });
        this.#o.logger.info({ backupId: backup.id }, 'old backup pruned');
      }
    } catch (err) {
      this.#o.logger.warn({ err: describe(err) }, 'pruning old backups failed');
    }
  }
}

/** Pre-migration backups kept, newest first; older ones are pruned after a new one. */
export const PRE_MIGRATION_KEEP = 3;

/** Where pre-migration backups go: their own folder, outside the API's list and `MULTITAP_BACKUP_KEEP`. */
export function preMigrationDir(backupDir: string): string {
  return join(backupDir, 'pre-migration');
}

/**
 * Backs the database up before pending migrations run (okf:architecture/core-persistence),
 * as `multitap-<timestamp>-before-<first pending migration>.sqlite` in
 * {@link preMigrationDir}, keeping the newest {@link PRE_MIGRATION_KEEP}. The
 * same online copy and checks as {@link BackupService}. Multitap and the CLI pass it
 * to `migrateToLatest`; a failure throws, so the upgrade doesn't start without a copy.
 */
export async function backupBeforeMigrating(
  deps: { db: Db; logger: Logger; clock: Clock; backupDir: string },
  pending: readonly string[],
): Promise<void> {
  const { db, logger, clock } = deps;
  const dir = preMigrationDir(deps.backupDir);
  const name = `${PREFIX}${stamp(clock())}-before-${pending[0] ?? 'migrating'}${SUFFIX}`;
  try {
    const size = await writeSnapshot(db, dir, name);
    logger.info({ backup: name, pending, sizeBytes: size }, 'backup written before migrating');
  } catch (err) {
    logger.error({ backup: name, err: describe(err) }, 'backup before migrating failed');
    throw new Error(
      'Backing up the database before migrating failed, so the upgrade did not start. ' +
        `Check that ${dir} is writable and the disk has room.`,
      { cause: err },
    );
  }
  try {
    const names = (await fs.readdir(dir))
      .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
      .sort()
      .reverse();
    for (const old of names.slice(PRE_MIGRATION_KEEP)) {
      await fs.rm(join(dir, old), { force: true });
      logger.info({ backup: old }, 'old pre-migration backup pruned');
    }
  } catch (err) {
    logger.warn({ err: describe(err) }, 'pruning old pre-migration backups failed');
  }
}

/**
 * Writes a verified online copy of `db` to `dir/name` and returns its size. It
 * is written as `name.partial` and renamed only once checked; leftovers of a
 * copy a crash cut short are removed first.
 */
async function writeSnapshot(db: Db, dir: string, name: string): Promise<number> {
  const finalPath = join(dir, name);
  const partial = `${finalPath}${PARTIAL}`;
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const stale of await fs.readdir(dir)) {
      if (stale.endsWith(`${SUFFIX}${PARTIAL}`)) await fs.rm(join(dir, stale), { force: true });
    }
    // Created first with a restrictive mode, so the contents are never
    // readable by others, even briefly (modes are a no-op on Windows).
    closeSync(openSync(partial, 'wx', 0o600));
    await sqliteHandle(db).backup(partial);
    finishAndVerify(partial);
    await fs.rename(partial, finalPath);
    return (await fs.stat(finalPath)).size;
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
}

function toBackup(id: string, sizeBytes: number): Backup {
  return {
    id,
    createdAt: new Date(stampToMs(id)).toISOString(),
    sizeBytes,
    kind: id.endsWith(SCHEDULED_TAG) ? 'scheduled' : 'manual',
  };
}

/** An error's message only: enough to act on, nothing a log shouldn't carry. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The online backup copies the WAL flag in the file header; turning it off
 * makes the backup one self-contained file with no `-wal`/`-shm` beside it.
 * Then the copy is reopened read-only and checked.
 */
function finishAndVerify(path: string): void {
  const writable = new SQLite(path);
  try {
    writable.pragma('journal_mode = DELETE');
  } finally {
    writable.close();
  }
  const copy = new SQLite(path, { readonly: true });
  try {
    const rows = copy.pragma('integrity_check') as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error('integrity_check failed on the backup copy');
    }
  } finally {
    copy.close();
  }
}
