// Engine descriptors carry `localAddon` (okf:concept/engine-descriptor): the engine serves
// local content, whose streams only it can play. Same rules as 0001: erasable
// TypeScript only, never import from src/.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('engines')
    .addColumn('local_addon', 'integer', (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`local_addon in (0, 1)`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('engines').dropColumn('local_addon').execute();
}
