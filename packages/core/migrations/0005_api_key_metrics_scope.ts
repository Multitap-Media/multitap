// Add 'metrics' scope to api_keys (okf:architecture/core-api-keys-security). SQLite can't modify CHECK constraints,
// so we rebuild the table.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create new table with updated constraint
  await db.schema
    .createTable('api_keys_new')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('key_hash', 'text', (col) => col.notNull().unique())
    .addColumn('scope', 'text', (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_used', 'integer')
    .addColumn('revoked_at', 'integer')
    .addCheckConstraint('api_keys_scope', sql`scope in ('client', 'admin', 'metrics')`)
    .modifyEnd(sql`strict`)
    .execute();

  // Copy data
  await sql`
    INSERT INTO api_keys_new (id, key_hash, scope, label, created_at, last_used, revoked_at)
    SELECT id, key_hash, scope, label, created_at, last_used, revoked_at FROM api_keys
  `.execute(db);

  // Drop old table and rename new one
  await db.schema.dropTable('api_keys').execute();
  await sql`ALTER TABLE api_keys_new RENAME TO api_keys`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The old constraint has no `metrics` scope and no lower scope to map those
  // keys to, so they are deleted (re-create them after re-applying the migration).
  await sql`DELETE FROM api_keys WHERE scope = 'metrics'`.execute(db);

  // Create old table with original constraint
  await db.schema
    .createTable('api_keys_new')
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

  // Copy data back
  await sql`
    INSERT INTO api_keys_new (id, key_hash, scope, label, created_at, last_used, revoked_at)
    SELECT id, key_hash, scope, label, created_at, last_used, revoked_at FROM api_keys
  `.execute(db);

  // Drop new table and rename back
  await db.schema.dropTable('api_keys').execute();
  await sql`ALTER TABLE api_keys_new RENAME TO api_keys`.execute(db);
}
