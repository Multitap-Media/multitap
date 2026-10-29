// Phase 2 tables (okf:architecture/core-persistence): playback sessions, engine sessions,
// token revocations, profiles and their library, and operator settings.
// `prepare_jobs` waits for phase 4. Same rules as 0001: erasable TypeScript
// only, never import from src/. Timestamps are integer Unix milliseconds.
//
// Secret columns (okf:architecture/secrets-policy): `playback_sessions.stream_json` (the raw addon
// `Stream`) and `engine_sessions.media_url`. They are never returned by the API
// or logged at `info` and above; see SECRET_COLUMNS in src/db/schema.ts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('playback_sessions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('key', 'text')
    .addColumn('item_type', 'text', (col) => col.notNull())
    .addColumn('item_id', 'text', (col) => col.notNull())
    .addColumn('video_id', 'text')
    // The request's source, as JSON: {"key": "..."} or {"auto": true}.
    .addColumn('source_json', 'text', (col) => col.notNull())
    // Hash of everything that makes two creates the same session (okf:architecture/playback-session, okf:architecture/rendition-and-bandwidth):
    // key, item, source, requested delivery, requested quality. Null without a key.
    .addColumn('identity', 'text')
    .addColumn('candidates_json', 'text')
    .addColumn('chosen_key', 'text')
    .addColumn('stream_json', 'text') // secret
    .addColumn('engine_id', 'text')
    .addColumn('sid', 'text')
    .addColumn('delivery', 'text', (col) => col.notNull())
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('high_res', 'text', (col) => col.notNull())
    .addColumn('requested_quality_json', 'text')
    .addColumn('quality_json', 'text')
    .addColumn('ready_by', 'integer')
    .addColumn('retain_until', 'integer')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('failure_reason', 'text')
    .addColumn('token_epoch', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('last_access', 'integer', (col) => col.notNull())
    .addColumn('released_at', 'integer')
    .addCheckConstraint(
      'playback_sessions_status',
      sql`status in ('resolving', 'preparing', 'ready', 'failed', 'released')`,
    )
    .addCheckConstraint(
      'playback_sessions_delivery',
      sql`delivery in ('direct', 'remux', 'transcode')`,
    )
    .addCheckConstraint('playback_sessions_mode', sql`mode in ('play', 'full')`)
    .addCheckConstraint('playback_sessions_high_res', sql`high_res in ('off', 'prepareOnly', 'on')`)
    .modifyEnd(sql`strict`)
    .execute();
  await db.schema
    .createIndex('playback_sessions_identity')
    .on('playback_sessions')
    .column('identity')
    .execute();
  await db.schema
    .createIndex('playback_sessions_status')
    .on('playback_sessions')
    .column('status')
    .execute();

  await db.schema
    .createTable('engine_sessions')
    .addColumn('sid', 'text', (col) => col.notNull())
    .addColumn('engine_id', 'text', (col) => col.notNull())
    // The playback session id (okf:architecture/engine-prepare-stream); not a foreign key, the engine module
    // knows nothing about playback sessions.
    .addColumn('session_key', 'text', (col) => col.notNull())
    .addColumn('stream_hash', 'text', (col) => col.notNull())
    // Canonical form of the quality overrides the engine session was created
    // with ('' for none), so two qualities never share one engine session (okf:architecture/rendition-and-bandwidth).
    .addColumn('quality_key', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('applied_quality_json', 'text')
    .addColumn('media_url', 'text', (col) => col.notNull()) // secret
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_used', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('engine_sessions_pk', ['engine_id', 'sid'])
    .addUniqueConstraint('engine_sessions_lookup', [
      'engine_id',
      'session_key',
      'stream_hash',
      'quality_key',
    ])
    .modifyEnd(sql`strict`)
    .execute();

  await db.schema
    .createTable('token_revocations')
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('playback_sessions.id').onDelete('cascade'),
    )
    .addColumn('subject', 'text', (col) => col.notNull())
    // Kept until the last token for this subject could have expired.
    .addColumn('until', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('token_revocations_pk', ['session_id', 'subject'])
    .modifyEnd(sql`strict`)
    .execute();

  await db.schema
    .createTable('profiles')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .modifyEnd(sql`strict`)
    .execute();

  // One row per stremio-core LibraryItem (ref/stremio-core/src/types/library/library_item.rs).
  await db.schema
    .createTable('library_items')
    .addColumn('profile_id', 'text', (col) =>
      col.notNull().references('profiles.id').onDelete('cascade'),
    )
    .addColumn('item_id', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('poster', 'text')
    .addColumn('poster_shape', 'text', (col) => col.notNull().defaultTo('poster'))
    .addColumn('removed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('temp', 'integer', (col) => col.notNull().defaultTo(0))
    // LibraryItemState and MetaItemBehaviorHints, as JSON in stremio-core's field names.
    .addColumn('state_json', 'text', (col) => col.notNull())
    .addColumn('behavior_hints_json', 'text', (col) => col.notNull())
    .addColumn('ctime', 'integer')
    .addColumn('mtime', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('library_items_pk', ['profile_id', 'item_id'])
    .addCheckConstraint('library_items_removed_bool', sql`removed in (0, 1)`)
    .addCheckConstraint('library_items_temp_bool', sql`temp in (0, 1)`)
    .modifyEnd(sql`strict`)
    .execute();
  await db.schema
    .createIndex('library_items_profile_mtime')
    .on('library_items')
    .columns(['profile_id', 'mtime'])
    .execute();

  // Only values an operator changed are stored, over built-in defaults (okf:concept/ranking-settings).
  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value_json', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .modifyEnd(sql`strict`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('settings').execute();
  await db.schema.dropTable('library_items').execute();
  await db.schema.dropTable('profiles').execute();
  await db.schema.dropTable('token_revocations').execute();
  await db.schema.dropTable('engine_sessions').execute();
  await db.schema.dropTable('playback_sessions').execute();
}
