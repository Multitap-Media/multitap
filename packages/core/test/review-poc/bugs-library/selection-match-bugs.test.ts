/**
 * Review PoC (rule 7 matching). `it.fails` asserts the CORRECT behaviour.
 */
import { describe, expect, it } from 'vitest';
import { mismatchOf } from '../../../src/selection/match.ts';

describe('title match: a possessive prefix releases usually drop', () => {
  it.fails('a season pack named without the prefix is the same show', () => {
    const target = { name: "Tom Clancy's Jack Ryan", year: 2018, season: 1, episode: 5 };
    expect(mismatchOf({ title: 'Jack.Ryan.S01.1080p.AMZN.WEB-DL.DDP5.1.H.264' }, target)).toBe(
      undefined,
    );
  });
});

describe('specials (season 0)', () => {
  it.fails('a file with no numbers in a multi-season pack is not another episode', () => {
    const target = { name: 'Show', season: 0, episode: 5 };
    // The file name says nothing; the pack lists S01-S03 (packs often carry specials too).
    expect(mismatchOf({ title: 'Show.S01-S03.1080p\nShow.Christmas.Special.mkv' }, target)).toBe(
      undefined,
    );
  });
});
