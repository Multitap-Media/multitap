/**
 * Retention (okf:architecture/engine-retention): a session is kept until
 * `max(retainUntil, lastAccess + retention.idle)`, then released. The SQL in
 * `SqliteSessionRepository.listDueForRelease` is the same rule.
 */
export interface RetentionInput {
  retainUntil: number | null;
  lastAccess: number;
}

/** When the session's retention ends, Unix ms. */
export function retentionDeadline(session: RetentionInput, idleMs: number): number {
  return Math.max(session.retainUntil ?? 0, session.lastAccess + idleMs);
}

/** Whether a session is due for release at `now`. */
export function isDueForRelease(session: RetentionInput, idleMs: number, now: number): boolean {
  return retentionDeadline(session, idleMs) <= now;
}
