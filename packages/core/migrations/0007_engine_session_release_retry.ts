// A pending engine release (okf:architecture/engine-retention): when `DELETE /hlsv2/{sid}`
// can't reach the engine, the `engine_sessions` row stays with
// `release_pending_since` set, and the retention sweep retries the delete with
// backoff (`release_attempts`, `release_next_at`) until the engine confirms the
// session is gone. Same rules as 0001: erasable TypeScript only, never import
// from src/.
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('engine_sessions')
    .addColumn('release_pending_since', 'integer')
    .execute();
  await db.schema
    .alterTable('engine_sessions')
    .addColumn('release_attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('engine_sessions').addColumn('release_next_at', 'integer').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('engine_sessions').dropColumn('release_next_at').execute();
  await db.schema.alterTable('engine_sessions').dropColumn('release_attempts').execute();
  await db.schema.alterTable('engine_sessions').dropColumn('release_pending_since').execute();
}
