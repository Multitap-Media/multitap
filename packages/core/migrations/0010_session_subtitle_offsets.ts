// Session-level subtitle timing offsets (okf:architecture/core-subtitles-and-player-state): one row per
// (session, subtitle file) whose offset is not 0, deleted with the session.
// Non-secret. Same rules as 0001: erasable TypeScript only, never import from src/.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('session_subtitle_offsets')
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('playback_sessions.id').onDelete('cascade'),
    )
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('offset_ms', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('session_subtitle_offsets_pk', ['session_id', 'file_id'])
    .modifyEnd(sql`strict`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('session_subtitle_offsets').execute();
}
