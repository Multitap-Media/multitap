// Preparing ahead (okf:architecture/engine-prepare-ahead, okf:process/phase-4-core-checklist; phase 4): one
// `prepare_jobs` row per `full` playback session, so a restart picks its
// preparations up again, and `engine_sessions.prepared`, which marks the engine
// sessions that get the long prepared `ttl`. Non-secret: ids, times and counts.
// Same rules as 0001: erasable TypeScript only, never import from src/.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('prepare_jobs')
    .addColumn('session_id', 'text', (col) =>
      col.primaryKey().references('playback_sessions.id').onDelete('cascade'),
    )
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('audio', 'text', (col) => col.notNull())
    .addColumn('height', 'integer')
    .addColumn('start_at', 'integer', (col) => col.notNull())
    .addColumn('ready_by', 'integer')
    .addColumn('started_at', 'integer')
    .addColumn('start_segments', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_segments', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('done_segments', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('restarts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('late_notified', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('verified_at', 'integer')
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .modifyEnd(sql`strict`)
    .execute();
  await db.schema
    .alterTable('engine_sessions')
    .addColumn('prepared', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('engine_sessions').dropColumn('prepared').execute();
  await db.schema.dropTable('prepare_jobs').execute();
}
