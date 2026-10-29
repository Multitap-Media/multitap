// Phase 1 tables (okf:architecture/core-persistence). Migrations are loaded by Node's type
// stripping, never compiled (see MIGRATIONS_DIR in src/db/index.ts): erasable
// TypeScript only, and never import from src/, which isn't there in the image.
// Timestamps are integer Unix milliseconds. Tables are STRICT.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('addons')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('manifest_url', 'text', (col) => col.notNull().unique())
    .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('manifest_json', 'text', (col) => col.notNull())
    .addColumn('manifest_fetched_at', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addCheckConstraint('addons_enabled_bool', sql`enabled in (0, 1)`)
    .modifyEnd(sql`strict`)
    .execute();
  await db.schema.createIndex('addons_position').on('addons').column('position').execute();

  await db.schema
    .createTable('engines')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('transport', 'text', (col) => col.notNull())
    .addColumn('address', 'text')
    .addColumn('capabilities_json', 'text', (col) => col.notNull())
    .addColumn('last_seen', 'integer')
    .modifyEnd(sql`strict`)
    .execute();

  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('key_hash', 'text', (col) => col.notNull().unique())
    .addColumn('scope', 'text', (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_used', 'integer')
    .addColumn('revoked_at', 'integer')
    .addCheckConstraint('api_keys_scope', sql`scope in ('client', 'admin')`)
    .modifyEnd(sql`strict`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('api_keys').execute();
  await db.schema.dropTable('engines').execute();
  await db.schema.dropTable('addons').execute();
}
