import { join } from 'node:path';
import SQLite from 'better-sqlite3';

/** File name of the single-instance lock inside `MULTITAP_DATA_DIR`. */
export const LOCK_FILE = 'multitap.lock';

/** Thrown by {@link lockDataDir} when another Multitap holds the data folder. */
export class DataDirLockedError extends Error {
  override name = 'DataDirLockedError';
  readonly dataDir: string;
  constructor(dataDir: string, options?: ErrorOptions) {
    super(
      `Another Multitap is already running with the data folder ${dataDir} (it holds ` +
        `${LOCK_FILE} there), so this one did not start: it would mark that instance's ` +
        'resolving sessions as interrupted and race it for the database. Stop the other ' +
        'instance first, or give this one its own MULTITAP_DATA_DIR.',
      options,
    );
    this.dataDir = dataDir;
  }
}

/** The lock connections this process holds. */
const held = new Set<SQLite.Database>();

export interface DataDirLock {
  /** Releases the lock; safe to call more than once. */
  release(): void;
}

/**
 * Takes the data folder's single-instance lock (okf:architecture/core-persistence)
 * before Multitap migrates or touches sessions, so a second server on the same
 * folder stops before it changes anything.
 *
 * The lock is an exclusive SQLite transaction held open on `multitap.lock`
 * for the life of the process: SQLite locks the file with the operating system
 * (POSIX advisory locks, `LockFileEx` on Windows), which the kernel drops when
 * the process exits however it exits, so a crash or `SIGKILL` never leaves a
 * stale lock behind and there is no PID to second-guess (a PID file can't tell
 * two containers apart, both PID 1). It also holds between two connections of
 * one process, and between containers sharing a volume on one host.
 *
 * Only the server takes it: the CLI is meant to run beside a running Multitap
 * and shares the database through SQLite's own locking.
 *
 * @throws {DataDirLockedError} when another process (or another start in this
 *   one) holds it.
 */
export function lockDataDir(dataDir: string): DataDirLock {
  const handle = new SQLite(join(dataDir, LOCK_FILE));
  try {
    handle.pragma('busy_timeout = 0');
    handle.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    handle.close();
    if ((err as { code?: unknown }).code === 'SQLITE_BUSY') {
      throw new DataDirLockedError(dataDir, { cause: err });
    }
    throw err;
  }
  // Referenced until released: better-sqlite3 closes a collected connection,
  // which would drop the lock while Multitap still runs.
  held.add(handle);
  return {
    release() {
      if (!held.delete(handle)) return;
      try {
        handle.exec('ROLLBACK');
      } finally {
        handle.close();
      }
    },
  };
}
