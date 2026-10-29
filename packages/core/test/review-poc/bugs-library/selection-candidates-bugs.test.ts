/**
 * Review PoC (candidate keys). `it.fails` asserts the CORRECT behaviour.
 *
 * A torrent stream without `fileIdx` picks its file by `fileMustInclude` or
 * `behaviorHints.filename` (engines/resolve.ts), but the key only hashes
 * `infoHash` and `fileIdx`: two different files of one pack share a key, so
 * the StreamStore entry of one is overwritten by the other.
 */
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { toCandidates } from '../../../src/selection/index.ts';
import { StreamStore } from '../../../src/selection/stream-store.ts';

const HASH = 'a'.repeat(40);
const addon = { id: 'pack-addon', name: 'Pack addon' };

describe('torrent keys without fileIdx', () => {
  it.fails('different fileMustInclude in the same torrent are different candidates', () => {
    const e1 = StreamSchema.parse({ infoHash: HASH, fileMustInclude: ['S01E01'] });
    const e2 = StreamSchema.parse({ infoHash: HASH, fileMustInclude: ['S01E02'] });
    const [a, b] = toCandidates(addon, [e1, e2]).map((c) => c.candidate.key);
    expect(a).not.toBe(b);
  });

  it.fails('different behaviorHints.filename in the same torrent are different candidates', () => {
    const e1 = StreamSchema.parse({
      infoHash: HASH,
      behaviorHints: { filename: 'Show.S01E01.mkv' },
    });
    const e2 = StreamSchema.parse({
      infoHash: HASH,
      behaviorHints: { filename: 'Show.S01E02.mkv' },
    });
    const [a, b] = toCandidates(addon, [e1, e2]).map((c) => c.candidate.key);
    expect(a).not.toBe(b);
  });

  it.fails('listing episode 2 does not change what the episode 1 key plays', () => {
    const store = new StreamStore({ clock: () => 0 });
    const e1 = StreamSchema.parse({ infoHash: HASH, fileMustInclude: ['S01E01'] });
    const e2 = StreamSchema.parse({ infoHash: HASH, fileMustInclude: ['S01E02'] });
    const [c1] = toCandidates(addon, [e1]);
    const [c2] = toCandidates(addon, [e2]);
    if (!c1 || !c2) throw new Error('expected one candidate per stream');
    // What source-list.ts does for each listing:
    store.put(c1.candidate.key, {
      addonId: addon.id,
      type: 'series',
      videoId: 'tt1:1:1',
      stream: e1,
    });
    store.put(c2.candidate.key, {
      addonId: addon.id,
      type: 'series',
      videoId: 'tt1:1:2',
      stream: e2,
    });
    expect(store.get(c1.candidate.key)?.videoId).toBe('tt1:1:1');
  });
});
