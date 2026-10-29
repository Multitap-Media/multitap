/**
 * Review PoC: `itemFromRow` JSON.parses `state_json`/`behavior_hints_json`
 * unguarded, so one unreadable library row (a hand-edited or partially
 * restored database) makes the profile's whole library, continue-watching and
 * every progress report for that item throw (500), where the rest of Multitap's
 * stored JSON (settings_json, subtitle_json, manifests) degrades per row.
 */
import { describe, expect, it } from 'vitest';
import { sequentialIds } from '../../../src/lib/ids.ts';
import { LibraryService } from '../../../src/library/service.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from '../../helpers.ts';

async function setup() {
  const db = await migratedMemoryDb();
  const clock = manualClock();
  const library = new LibraryService({
    db,
    clock,
    logger: memoryLogger().logger,
    meta: () => Promise.resolve(undefined),
    ids: sequentialIds(),
  });
  return { db, clock, library };
}

const row = (profileId: string, itemId: string, stateJson: string) => ({
  profile_id: profileId,
  item_id: itemId,
  type: 'movie',
  name: itemId,
  poster: null,
  state_json: stateJson,
  behavior_hints_json: '{}',
  ctime: 1,
  mtime: 1,
});

describe('library persistence (review PoC)', () => {
  it.fails('one unreadable library row does not hide the rest of the library', async () => {
    const t = await setup();
    const profile = await t.library.createProfile('p');
    await t.library.report(profile.id, {
      item: { type: 'movie', id: 'tt0000001' },
      name: 'Good',
      time: 60_000,
      duration: 6_000_000,
      event: 'pause',
    } as never);
    await t.db
      .insertInto('library_items')
      .values(row(profile.id, 'tt0000002', '{bad'))
      .execute();

    // Expected: the good item is listed (the bad one skipped or defaulted). Actual: SyntaxError.
    const items = await t.library.library(profile.id);
    expect(items?.map((i) => i._id)).toContain('tt0000001');
  });
});
