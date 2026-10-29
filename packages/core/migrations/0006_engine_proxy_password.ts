// The engine's proxy password (okf:architecture/secrets-classes-and-engine-password): a secret column, sent as
// `api_password` on the `/proxy/stream` URLs Multitap builds, never returned or
// logged. Null = none. Same rules as 0001: erasable TypeScript only, never
// import from src/.
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('engines').addColumn('proxy_password', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('engines').dropColumn('proxy_password').execute();
}
