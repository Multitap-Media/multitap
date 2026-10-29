// The `home` seed changed after phase 1 shipped: phase 0 measured tonemap on
// and a live concurrency of 2, and capabilities gained `sessionOverrides` (#25).
// A database seeded before that still holds the old values. Update `home` only
// if it is still exactly the old seed, so an operator's edits survive; every
// other row without `sessionOverrides` gets `false`, the safe value, because
// the capability is now required. Same rules as 0001: erasable TypeScript only,
// never import from src/.
import type { Kysely } from 'kysely';

interface EngineRow {
  id: string;
  capabilities_json: string;
}

const OLD_HOME_SEED: Record<string, unknown> = {
  hwaccel: 'qsv',
  liveMaxHeight: 1080,
  preparedMaxHeight: 2160,
  tonemap: false,
  liveConcurrency: 3,
  prepareConcurrency: 1,
};

const NEW_HOME_SEED: Record<string, unknown> = {
  hwaccel: 'qsv',
  liveMaxHeight: 1080,
  preparedMaxHeight: 2160,
  tonemap: true,
  sessionOverrides: true,
  liveConcurrency: 2,
  prepareConcurrency: 1,
};

function isOldHomeSeed(capabilities: Record<string, unknown>): boolean {
  const keys = Object.keys(capabilities);
  return (
    keys.length === Object.keys(OLD_HOME_SEED).length &&
    keys.every((key) => capabilities[key] === OLD_HOME_SEED[key])
  );
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const typed = db as unknown as Kysely<{ engines: EngineRow }>;
  const rows = await typed.selectFrom('engines').select(['id', 'capabilities_json']).execute();
  for (const row of rows) {
    let capabilities: Record<string, unknown>;
    try {
      capabilities = JSON.parse(row.capabilities_json) as Record<string, unknown>;
    } catch {
      continue; // Left for the engine registry to report.
    }
    let next: Record<string, unknown> | undefined;
    if (row.id === 'home' && isOldHomeSeed(capabilities)) {
      next = NEW_HOME_SEED;
    } else if (!('sessionOverrides' in capabilities)) {
      next = { ...capabilities, sessionOverrides: false };
    }
    if (next !== undefined) {
      await typed
        .updateTable('engines')
        .set({ capabilities_json: JSON.stringify(next) })
        .where('id', '=', row.id)
        .execute();
    }
  }
}

export async function down(): Promise<void> {
  // Data-only migration: the previous values aren't kept, and the new ones are valid there too.
}
