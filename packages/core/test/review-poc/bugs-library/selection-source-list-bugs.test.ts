/**
 * Review PoC (incremental source list, `streams.partial`). `it.fails` asserts
 * the CORRECT behaviour.
 *
 * 1. `emit` (a hoisted function) uses `let partials`, which is declared only
 *    after `await lookup` and `await collection.get(...)`. A stream addon that
 *    answers while the item's meta lookup is still running calls `emit` in
 *    the temporal dead zone: a ReferenceError that aggregate's `onOutcome`
 *    try/catch swallows, so that addon's partial is never sent.
 * 2. A synthetic part (meta-embedded streams, or a `yt_id:` derived stream)
 *    is emitted last with `emit(own, 0)`, but `emit` adds 1 for the synthetic
 *    part to every `remaining`, so no partial ever says `remaining: 0`.
 */
import { DEFAULT_RANKING_SETTINGS } from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import type { AddonOutcome, AddonService } from '../../../src/addons/index.ts';
import { HOME_ENGINE } from '../../engine-fixture.ts';
import type { ItemInfo } from '../../../src/selection/item-meta.ts';
import { startSourceList, type SourcePartial } from '../../../src/selection/source-list.ts';
import { StreamStore } from '../../../src/selection/stream-store.ts';

const engine = { id: HOME_ENGINE.id, capabilities: HOME_ENGINE.capabilities };
const record = (id: string, name: string) => ({
  id,
  manifest: { name, behaviorHints: { configurationRequired: false } },
});
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One stream addon; it answers after `answerMs` (asynchronously, like the real aggregate). */
function fakeAddons(answerMs: number): AddonService {
  const records = [record('meta-addon', 'Meta'), record('stream-addon', 'Streams')];
  const outcome: AddonOutcome<'stream'> = {
    addonId: 'stream-addon',
    addonName: 'Streams',
    status: 'ok',
    items: [StreamSchema.parse({ url: 'https://example.com/a.mkv', name: 'A' })],
    dropped: 0,
  };
  const fake = {
    collection: {
      index: () => Promise.resolve({ match: () => [records[1]] }),
      get: (id: string) => Promise.resolve(records.find((r) => r.id === id)),
      list: () => Promise.resolve(records),
    },
    aggregate: async (
      _resource: string,
      _type: string,
      _id: string,
      _extra: unknown,
      options: { onOutcome?: (o: AddonOutcome<'stream'>, remaining: number) => void },
    ) => {
      await tick(answerMs);
      try {
        options.onOutcome?.(outcome, 0);
      } catch {
        // As the real aggregate does: a throwing callback doesn't fail the call.
      }
      return { addons: [outcome], items: outcome.items };
    },
  };
  return fake as unknown as AddonService;
}

async function run(answerMs: number, metaMs: number, info: ItemInfo) {
  const partials: SourcePartial[] = [];
  const started = await startSourceList(
    {
      addons: fakeAddons(answerMs),
      streams: new StreamStore({ clock: () => 0 }),
      meta: { lookup: async () => (await tick(metaMs), info) },
    },
    {
      type: 'movie',
      videoId: 'tt0000001',
      engine,
      highRes: 'off',
      rank: { settings: DEFAULT_RANKING_SETTINGS },
    },
    (p) => partials.push(p),
  );
  const result = await started.done;
  return { started, partials, result };
}

describe('streams.partial', () => {
  it.fails(
    'an addon answering before the meta lookup finishes still gets its partial',
    async () => {
      // The stream addon answers in 5 ms, the meta lookup takes 50 ms.
      const { partials, result } = await run(5, 50, { target: { name: 'Movie' } });
      expect(result.candidates).toHaveLength(1); // the full list has it...
      expect(partials.map((p) => p.addon.addonId)).toEqual(['stream-addon']); // ...the events don't
    },
  );

  it.fails('with a meta-embedded part, the last partial says remaining 0', async () => {
    // The meta lookup is fast here, so only the remaining count is under test.
    const { started, partials } = await run(20, 0, {
      target: { name: 'Movie' },
      embedded: {
        addonId: 'meta-addon',
        addonName: 'Meta',
        streams: [StreamSchema.parse({ url: 'https://example.com/b.mkv', name: 'B' })],
      },
    });
    expect(started.asked).toBe(2);
    expect(partials.map((p) => [p.addon.addonId, p.remaining])).toEqual([
      ['stream-addon', 1],
      ['meta-addon', 0],
    ]);
  });
});
