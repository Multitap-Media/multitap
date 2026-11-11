/**
 * Retention (okf:architecture/engine-retention): a session is kept until
 * `max(retainUntil, lastAccess + retention.idle, readyBy + retention.idle)`,
 * then released; a session that is `preparing` is never due, and a failed one
 * isn't kept for its `readyBy`. The SQL in
 * `SqliteSessionRepository.listDueForRelease` is the same rule.
 */
export interface RetentionInput {
  retainUntil: number | null;
  lastAccess: number;
  /** A `full` session's preparation deadline: it is kept until this plus the idle time. */
  readyBy?: number | null;
  status?: string;
}

/** When the session's retention ends, Unix ms. */
export function retentionDeadline(session: RetentionInput, idleMs: number): number {
  return Math.max(
    session.retainUntil ?? 0,
    session.lastAccess + idleMs,
    session.readyBy == null || session.status === 'failed' ? 0 : session.readyBy + idleMs,
  );
}

/** Whether a session is due for release at `now`. */
export function isDueForRelease(session: RetentionInput, idleMs: number, now: number): boolean {
  return session.status !== 'preparing' && retentionDeadline(session, idleMs) <= now;
}
