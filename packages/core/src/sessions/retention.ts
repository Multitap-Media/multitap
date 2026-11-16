/**
 * Retention (okf:architecture/engine-retention): a session is kept until
 * `max(retainUntil, lastAccess + idle, readyBy + idle)`, then released; a
 * session that is `preparing` is never due, and a failed one isn't kept for
 * its `readyBy`. `idle` is `MULTITAP_RETENTION_IDLE_MS`, except for a `full`
 * session that hasn't failed: a prepared session is kept as long as its
 * engine session is (`MULTITAP_PREPARE_SESSION_TTL_MS`), when that is longer.
 * The SQL in `SqliteSessionRepository.listDueForRelease` is the same rule.
 */
export interface RetentionInput {
  retainUntil: number | null;
  lastAccess: number;
  /** A `full` session's preparation deadline: it is kept until this plus the idle time. */
  readyBy?: number | null;
  status?: string;
  mode?: string;
}

/** When the session's retention ends, Unix ms. `preparedIdleMs` applies to `full` sessions. */
export function retentionDeadline(
  session: RetentionInput,
  idleMs: number,
  preparedIdleMs = idleMs,
): number {
  const failed = session.status === 'failed';
  const idle = session.mode === 'full' && !failed ? Math.max(idleMs, preparedIdleMs) : idleMs;
  return Math.max(
    session.retainUntil ?? 0,
    session.lastAccess + idle,
    session.readyBy == null || failed ? 0 : session.readyBy + idle,
  );
}

/** Whether a session is due for release at `now`. */
export function isDueForRelease(
  session: RetentionInput,
  idleMs: number,
  now: number,
  preparedIdleMs = idleMs,
): boolean {
  return (
    session.status !== 'preparing' && retentionDeadline(session, idleMs, preparedIdleMs) <= now
  );
}
