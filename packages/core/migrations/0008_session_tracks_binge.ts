// What a playback session learned when its source became ready (see
// okf:architecture/playback-session): the source's audio and subtitle tracks from the engine's probe
// (`tracks_json`), the audio track the create request asked to start with
// (`audio_track`), and the source's `bingeGroup` for auto-next (okf:decision/auto-select-and-fallback). All
// null until `ready`. Same rules as 0001: erasable TypeScript only, never
// import from src/.
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('playback_sessions').addColumn('tracks_json', 'text').execute();
  await db.schema.alterTable('playback_sessions').addColumn('audio_track', 'integer').execute();
  await db.schema.alterTable('playback_sessions').addColumn('binge_group', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('playback_sessions').dropColumn('binge_group').execute();
  await db.schema.alterTable('playback_sessions').dropColumn('audio_track').execute();
  await db.schema.alterTable('playback_sessions').dropColumn('tracks_json').execute();
}
