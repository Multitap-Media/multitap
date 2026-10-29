/**
 * Review PoC: AddonCollection's load (`#readAll`) skips a row whose stored
 * manifest no longer passes ManifestSchema (e.g. after a release tightens the
 * schema), but the row stays in the table. The addon vanishes from the admin
 * list, `remove(id)` says not-found, and re-adding the same manifest URL hits
 * the UNIQUE(manifest_url) row and is refused as a duplicate: the operator can
 * neither see, delete nor reinstall it over the API. A stored manifest_json
 * that isn't JSON at all makes every collection call fail.
 */
import { ManifestSchema, type Manifest } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { AddonCollection } from '../../../src/addons/collection.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from '../../helpers.ts';

const URL_A = 'https://addon.example.com/manifest.json';
const URL_B = 'https://other.example.com/manifest.json';

const manifest = (id: string): Manifest =>
  ManifestSchema.parse({
    id,
    version: '1.0.0',
    name: id,
    types: ['movie'],
    resources: ['stream'],
    catalogs: [],
  });

async function setup() {
  const db = await migratedMemoryDb();
  const clock = manualClock();
  const collection = () =>
    new AddonCollection({
      db,
      logger: memoryLogger().logger,
      clock,
      fetchManifest: (url) => Promise.resolve(manifest(url.includes('other') ? 'b' : 'a')),
    });
  return { db, clock, collection };
}

describe('addon collection persistence (review PoC)', () => {
  it.fails(
    'an addon whose stored manifest no longer validates can still be reinstalled',
    async () => {
      const t = await setup();
      const added = await t.collection().add(URL_A);
      // A later release's schema rejects what an earlier one stored.
      await t.db
        .updateTable('addons')
        .set({ manifest_json: JSON.stringify({ id: 'a', name: 'a', version: 'not-semver' }) })
        .where('id', '=', added.id)
        .execute();

      const restarted = t.collection();
      expect(await restarted.list()).toEqual([]); // hidden from the admin list
      // Expected: the operator can reinstall it (or remove it). Actual: `duplicate`.
      await expect(restarted.add(URL_A)).resolves.toMatchObject({ manifestUrl: URL_A });
    },
  );

  it.fails('one unreadable manifest_json row does not take the whole collection down', async () => {
    const t = await setup();
    const a = await t.collection().add(URL_A);
    await t.collection().add(URL_B);
    await t.db
      .updateTable('addons')
      .set({ manifest_json: '{truncated' })
      .where('id', '=', a.id)
      .execute();

    // Expected: the good addon is still listed (the bad one skipped, as for a schema failure).
    // Actual: JSON.parse throws inside #readAll and every call rejects.
    const ids = (await t.collection().list()).map((r) => r.manifestUrl);
    expect(ids).toEqual([URL_B]);
  });
});
