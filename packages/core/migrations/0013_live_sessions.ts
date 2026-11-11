// Live HLS (okf:architecture/media-gateway "Live", okf:process/phase-4-core-checklist item 9): `live`
// marks a playback session that plays a live source through the engine's HLS
// proxy, and the engine session row that holds its proxy request (the engine
// itself keeps no session for it). Same rules as 0001: erasable TypeScript
// only, never import from src/.
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('engine_sessions')
    .addColumn('live', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('playback_sessions')
    .addColumn('live', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('playback_sessions').dropColumn('live').execute();
  await db.schema.alterTable('engine_sessions').dropColumn('live').execute();
}
