import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RANKING_SETTINGS, type SourceCandidate } from '@multitap/api';
import { MetaItemSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import type { AggregateResult } from '../src/addons/index.ts';
import { HOME_ENGINE } from './engine-fixture.ts';
import {
  ItemMetaLookup,
  annotate,
  itemInfo,
  mismatchOf,
  parseRuntime,
  sortByRank,
  splitVideoId,
  toCandidates,
  type MatchTarget,
} from '../src/selection/index.ts';
import { manualClock } from './helpers.ts';
import { REAL_STREAMS, must, realStreams, type RealAddon } from './selection-fixtures.ts';

const ADDONS: RealAddon[] = ['easynews', 'torrentio-public', 'torrentio-rd'];

/** Names and years of the items in the real fixtures (what Cinemeta says). */
const ITEMS: Record<string, { name: string; year: number }> = {
  tt0098904: { name: 'Seinfeld', year: 1989 },
  tt0108778: { name: 'Friends', year: 1994 },
  tt0386676: { name: 'The Office', year: 2005 },
  tt0903747: { name: 'Breaking Bad', year: 2008 },
  tt0944947: { name: 'Game of Thrones', year: 2011 },
  tt11198330: { name: 'House of the Dragon', year: 2022 },
  tt2861424: { name: 'Rick and Morty', year: 2013 },
  tt5180504: { name: 'The Witcher', year: 2019 },
  tt0111161: { name: 'The Shawshank Redemption', year: 1994 },
  tt0468569: { name: 'The Dark Knight', year: 2008 },
  tt0133093: { name: 'The Matrix', year: 1999 },
};

function candidates(addon: RealAddon, file: string): SourceCandidate[] {
  return toCandidates({ id: addon, name: addon }, realStreams(addon, file)).map((c) => c.candidate);
}

function targetFor(file: string): MatchTarget {
  const m = must(/^stream-(?:movie|series)-(tt\d+)(?:_(\d+)_(\d+))?\.json$/.exec(file), 'file');
  const item = must(ITEMS[must(m[1])], 'item');
  const target: MatchTarget = { name: item.name, year: item.year };
  if (m[2] !== undefined) {
    target.season = Number(m[2]);
    target.episode = Number(m[3]);
  }
  return target;
}

/** The file line of a candidate (the first release line). */
const fileOf = (c: SourceCandidate) => c.title.split('\n')[0] ?? '';

describe('mismatchOf: rows', () => {
  const ep: MatchTarget = { name: 'Breaking Bad', year: 2008, season: 1, episode: 1 };
  it.each<[string, string, MatchTarget, string | undefined]>([
    ['the episode', 'Breaking.Bad.S01E01.1080p.BluRay.x264.mkv', ep, undefined],
    ['another season', 'Breaking.Bad.S02E01.2160p.WEB-DL.mkv', ep, 'episode'],
    ['another episode', 'Breaking.Bad.S01E06.1080p.BluRay.mkv', ep, 'episode'],
    ['season pack', 'Breaking.Bad.S01.1080p.BluRay.x265-RARBG', ep, undefined],
    ['multi-season pack', 'Breaking Bad COMPLETE S01-S05 2160p WEB-DL', ep, undefined],
    ['pack of other seasons', 'Breaking.Bad.S03-S05.1080p.BluRay', ep, 'episode'],
    ['complete, no seasons', 'Breaking Bad Complete Series 1080p', ep, undefined],
    ['pack then the file', 'Breaking.Bad.S01.1080p\nBreaking.Bad.S01E01.Pilot.mkv', ep, undefined],
    ['pack then another file', 'Breaking.Bad.S01.1080p\nBreaking.Bad.S01E02.mkv', ep, 'episode'],
    ['absolute numbers prove nothing', '[Group] Breaking Bad - 001 [1080p].mkv', ep, undefined],
    ['folders don’t count', 'Pack [4x3]/Breaking Bad - 001.mkv', ep, undefined],
    ['another show', 'Better.Call.Saul.S01.1080p', ep, 'title'],
    ['another show, another episode', 'Better.Call.Saul.S02E03.1080p.mkv', ep, 'title'],
    ['translated name, the exact episode', 'Juego de Tronos S01E01.mkv', ep, undefined],
    ['punctuation and case', 'BREAKING-BAD_S01E01.mkv', ep, undefined],
    ['plural or suffix', 'Breaking Bads S01E01', ep, undefined],
    ['translated pack naming it', 'Во все тяжкие / Breaking Bad / Сезон: 1', ep, undefined],
    ['nothing to go on', '', ep, undefined],
  ])('%s', (_label, title, target, expected) => {
    expect(mismatchOf({ title }, target)).toBe(expected);
  });

  const movie: MatchTarget = { name: 'Spider-Man: No Way Home', year: 2021 };
  it.each<[string, string, string | undefined]>([
    ['the movie', 'Spider-Man.No.Way.Home.2021.2160p.mkv', undefined],
    ['without the subtitle', 'Spider-Man 2021 Extended 1080p', undefined],
    ['translated, with its year', 'Homem-Aranha Sem Volta Para Casa 2022 2160p', undefined],
    ['another movie', 'Venom.2018.2160p.mkv', 'title'],
    ['ignores a leading article', 'Office.S01E01', undefined],
  ])('movie: %s', (_label, title, expected) => {
    const target = _label.includes('article') ? { name: 'The Office' } : movie;
    expect(mismatchOf({ title }, target)).toBe(expected);
  });
});

describe('mismatchOf: real fixtures', () => {
  it('Easynews++ for Breaking Bad S01E01: S02 and other S01 episodes are mismatches', () => {
    const file = 'stream-series-tt0903747_1_1.json';
    const verdicts = candidates('easynews', file).map((c) => [
      fileOf(c),
      mismatchOf(c, targetFor(file)),
    ]);
    expect(verdicts).toEqual([
      ['Breaking.Bad.S02E01.2160p.WEB-DL.5xRus.Ukr.Eng.TrollUHD-ULTRAHDCLUB.mkv', 'episode'],
      ['Breaking.Bad.S02E02.German.Dubbed.DD51.DL.2160p.WebDL.x264-NIMA4K.mkv', 'episode'],
      ['Breaking.Bad.S01E01.1080p.BluRay.REMUX.Multi-Multi.AVC-PiR8.mkv', undefined],
      ['Breaking.Bad.S01E06.1080p.BluRay.REMUX.Multi-Multi.AVC-PiR8.mkv', 'episode'],
      ['Breaking.Bad.S1E01.Pilot.REMUX-FraMeSToR.mkv', undefined],
    ]);
  });

  it.each([
    'stream-series-tt0098904_3_5.json',
    'stream-series-tt0108778_1_1.json',
    'stream-series-tt0386676_1_1.json',
    'stream-series-tt0903747_1_1.json',
    'stream-series-tt0944947_1_1.json',
    'stream-series-tt2861424_1_1.json',
    'stream-series-tt5180504_1_1.json',
  ])('Torrentio season and complete packs containing the episode are unpenalised (%s)', (file) => {
    for (const addon of ['torrentio-public', 'torrentio-rd'] as const) {
      const flagged = candidates(addon, file).filter((c) => mismatchOf(c, targetFor(file)));
      expect(flagged.map(fileOf)).toEqual([]);
    }
  });

  it('Easynews++ results for other episodes of the series are mismatches; the episode is not', () => {
    for (const file of ['stream-series-tt5180504_1_1.json', 'stream-series-tt2861424_1_1.json']) {
      for (const c of candidates('easynews', file)) {
        const isEpisode = /S0?1E01\b/i.test(fileOf(c));
        expect(mismatchOf(c, targetFor(file))).toBe(isEpisode ? undefined : 'episode');
      }
    }
  });

  it('movies: translated titles with the year pass, unrelated files are a different title', () => {
    const shawshank = candidates('torrentio-public', 'stream-movie-tt0111161.json');
    const italian = shawshank.filter((c) => /Le ali della libert/i.test(c.title));
    expect(italian.length).toBeGreaterThan(0);
    for (const c of italian)
      expect(mismatchOf(c, targetFor('stream-movie-tt0111161.json'))).toBe(undefined);

    const matrix = candidates('torrentio-rd', 'stream-movie-tt0133093.json');
    const stooges = matrix.filter((c) => c.title.includes('Stooges'));
    expect(stooges.length).toBe(1);
    expect(mismatchOf(must(stooges[0]), targetFor('stream-movie-tt0133093.json'))).toBe('title');
  });
});

describe('ranking with mismatches', () => {
  const settings = DEFAULT_RANKING_SETTINGS;

  it('another episode ranks below every matching playable candidate, nothing is removed', () => {
    const file = 'stream-series-tt0903747_1_1.json';
    const target = targetFor(file);
    const all = ADDONS.flatMap((addon) => candidates(addon, file));
    const ranked = sortByRank(annotate(all, HOME_ENGINE, 'prepareOnly', { settings, target }));
    expect(ranked).toHaveLength(all.length);
    const wrong = ranked.filter((c) => mismatchOf(c, target) === 'episode');
    const right = ranked.filter((c) => c.playable && mismatchOf(c, target) === undefined);
    expect(wrong.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect(Math.max(...wrong.map((c) => c.score))).toBeLessThan(
      Math.min(...right.map((c) => c.score)),
    );
  });

  it('by default, the penalties outweigh every other rule combined', () => {
    // The best possible score of a mismatched candidate against the worst of a matching one.
    const s = settings;
    const best =
      s.tiers.debridCached +
      s.language.matchBonus +
      Math.max(...Object.values(s.resolution.points));
    const worst =
      s.tiers.weakTorrent -
      s.hdr.noTonemapPenalty -
      s.hdr.dvUnknownProfilePenalty -
      Math.max(...Object.values(s.decodeCost)) -
      Math.max(s.container.mpegtsLivePenalty, s.container.otherPenalty) -
      Math.max(s.size.tooSmallPenalty, s.size.tooLargeLivePenalty) -
      s.language.mismatchPenalty -
      s.release.preparedOnlyPenalty -
      Math.max(...Object.values(s.release.junkPenalty));
    expect(best - s.release.episodeMismatchPenalty).toBeLessThan(worst);
    expect(s.release.titleMismatchPenalty).toBeGreaterThan(s.release.episodeMismatchPenalty);
  });

  it('a different title ranks below another episode', () => {
    const target: MatchTarget = { name: 'Breaking Bad', season: 1, episode: 1 };
    const [episode, title] = annotate(
      [
        { ...must(candidates('easynews', 'stream-series-tt0903747_1_1.json')[0]), key: 'e' },
        {
          ...must(candidates('easynews', 'stream-series-tt0903747_1_1.json')[0]),
          key: 't',
          title: 'Better.Call.Saul.S02E01.2160p.WEB-DL.mkv',
        },
      ],
      HOME_ENGINE,
      'off',
      { settings, target },
    );
    expect(must(title).score).toBe(
      must(episode).score -
        settings.release.titleMismatchPenalty +
        settings.release.episodeMismatchPenalty,
    );
  });
});

describe('item meta', () => {
  const series = MetaItemSchema.parse(
    (
      JSON.parse(
        readFileSync(join(REAL_STREAMS, 'cinemeta', 'meta-series-tt0903747.json'), 'utf8'),
      ) as { meta: unknown }
    ).meta,
  );
  const movie = MetaItemSchema.parse(
    (
      JSON.parse(
        readFileSync(join(REAL_STREAMS, 'cinemeta', 'meta-movie-tt1375666.json'), 'utf8'),
      ) as { meta: unknown }
    ).meta,
  );

  it.each<[string | undefined, number | undefined]>([
    ['148 min', 8880],
    ['49 min', 2940],
    ['2h 28min', 8880],
    ['1h', 3600],
    ['45', 2700],
    ['N/A', undefined],
    [undefined, undefined],
  ])('parseRuntime(%s)', (text, expected) => {
    expect(parseRuntime(text)).toBe(expected);
  });

  it.each([
    ['series', 'tt0903747:1:2', { itemId: 'tt0903747', season: 1, episode: 2 }],
    ['movie', 'tt1375666', { itemId: 'tt1375666' }],
    ['series', 'kitsu:1376:5', { itemId: 'kitsu:1376' }],
    ['series', 'tt0903747', { itemId: 'tt0903747' }],
  ])('splitVideoId(%s, %s)', (type, id, expected) => {
    expect(splitVideoId(type, id)).toEqual(expected);
  });

  it('reads name, year, episode and runtime from Cinemeta', () => {
    expect(itemInfo(series, 'tt0903747:1:1', { season: 1, episode: 1 })).toEqual({
      target: { name: 'Breaking Bad', year: 2008, season: 1, episode: 1 },
      runtimeSec: 49 * 60,
    });
    expect(itemInfo(movie, 'tt1375666')).toEqual({
      target: { name: 'Inception', year: 2010 },
      runtimeSec: 148 * 60,
    });
  });

  it('looks up through the addon layer once, then from its cache', async () => {
    let calls = 0;
    const result = (items: unknown[]): AggregateResult<'meta'> => ({
      resource: 'meta',
      type: 'series',
      id: 'tt0903747',
      extra: [],
      addons: [{ addonId: 'c', addonName: 'C', status: 'ok', items: items as never, dropped: 0 }],
      items: items as never,
      dropped: 0,
    });
    const lookup = new ItemMetaLookup({
      clock: manualClock(),
      addons: {
        aggregate: ((_resource: string, _type: string, id: string) => {
          calls += 1;
          expect(id).toBe('tt0903747');
          return Promise.resolve(result([series]));
        }) as never,
      },
    });
    const [a, b] = await Promise.all([
      lookup.lookup('series', 'tt0903747:1:1'),
      lookup.lookup('series', 'tt0903747:1:1'),
    ]);
    expect(a).toEqual(b);
    expect(a?.target).toMatchObject({ name: 'Breaking Bad', season: 1, episode: 1 });
    await lookup.lookup('series', 'tt0903747:1:1');
    expect(calls).toBe(1);
  });

  it('a failing lookup yields nothing and is not fatal', async () => {
    const lookup = new ItemMetaLookup({
      clock: manualClock(),
      addons: {
        aggregate: () => Promise.reject(new Error('boom')),
      },
    });
    expect(await lookup.lookup('movie', 'tt1375666')).toBeUndefined();
  });
});
