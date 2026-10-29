// Profile settings and the last source per item (okf:architecture/library-and-profiles, okf:architecture/last-source-per-item):
// - `profiles.settings_json`: the settings a client stored (`ProfileSettings`
//   fields, sparse); null = every default. Read merged over the defaults, so a
//   later release's defaults reach what nobody set.
// - `playback_sessions.profile_id`: the profile a session was created for
//   (no foreign key: a session outlives a deleted profile and just records
//   nothing).
// - `last_sources`: the source each profile last played per item, one row per
//   (profile, item), deleted with the profile. Non-secret: the source identity
//   is a hash (the candidate key), the rest is what a source list shows.
// Same rules as 0001: erasable TypeScript only, never import from src/.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('profiles').addColumn('settings_json', 'text').execute();
  await db.schema.alterTable('playback_sessions').addColumn('profile_id', 'text').execute();
  await db.schema
    .createTable('last_sources')
    .addColumn('profile_id', 'text', (col) =>
      col.notNull().references('profiles.id').onDelete('cascade'),
    )
    .addColumn('item_id', 'text', (col) => col.notNull())
    .addColumn('video_id', 'text', (col) => col.notNull())
    .addColumn('source_identity', 'text', (col) => col.notNull())
    .addColumn('addon_id', 'text', (col) => col.notNull())
    .addColumn('addon_name', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('binge_group', 'text')
    .addColumn('played_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('last_sources_pk', ['profile_id', 'item_id'])
    .modifyEnd(sql`strict`)
    .execute();
  // Source lists look the row up by the video they list.
  await db.schema
    .createIndex('last_sources_profile_video')
    .on('last_sources')
    .columns(['profile_id', 'video_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('last_sources').execute();
  await db.schema.alterTable('playback_sessions').dropColumn('profile_id').execute();
  await db.schema.alterTable('profiles').dropColumn('settings_json').execute();
}
