// Per-item player state (okf:architecture/library-and-profiles, okf:architecture/core-subtitles-and-player-state; phase 3 P1): the audio
// language, subtitle choice, subtitle offset and playback speed a profile chose
// for an item, modelled on stremio-core's `StreamItemState`. One row per
// (profile, item), like `last_sources`, deleted with the profile. Non-secret:
// languages, an addon id and a subtitle file id (a hash), never a URL.
// Same rules as 0001: erasable TypeScript only, never import from src/.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('item_player_states')
    .addColumn('profile_id', 'text', (col) =>
      col.notNull().references('profiles.id').onDelete('cascade'),
    )
    .addColumn('item_id', 'text', (col) => col.notNull())
    .addColumn('audio_language', 'text')
    .addColumn('subtitle_json', 'text')
    .addColumn('subtitle_offset_ms', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('playback_speed', 'real')
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('item_player_states_pk', ['profile_id', 'item_id'])
    .modifyEnd(sql`strict`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('item_player_states').execute();
}
