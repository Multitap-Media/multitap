import {
  DEFAULT_RANKING_SETTINGS,
  mergeRankingSettings,
  type HighResPolicy,
  type ParsedSource,
  type RankingSettings,
  type SourceCandidate,
} from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { HOME_ENGINE } from './engine-fixture.ts';
import { annotate, playability, sortByRank, toCandidates } from '../src/selection/index.ts';
import { scoreCandidate } from '../src/selection/rank.ts';
import { must, realStreams, type RealAddon } from './selection-fixtures.ts';

/** The rule tests run against the defaults (okf:concept/source-ranking). */
const D = DEFAULT_RANKING_SETTINGS;
const defaults = { settings: D };
const DECODE_COST = D.decodeCost;
const TIER_DEBRID_CACHED = D.tiers.debridCached;
const TIER_HTTP = D.tiers.http;
const TIER_HEALTHY_TORRENT = D.tiers.healthyTorrent;
const TIER_WEAK_TORRENT = D.tiers.weakTorrent;
const HDR_PENALTY_NO_TONEMAP = D.hdr.noTonemapPenalty;
const HDR_TONEMAP_COST_LIVE = D.hdr.tonemapCostLive;
const HDR_TONEMAP_COST_PREPARED = D.hdr.tonemapCostPrepared;
const DV_UNKNOWN_PROFILE_PENALTY = D.hdr.dvUnknownProfilePenalty;
const MPEGTS_LIVE_PENALTY = D.container.mpegtsLivePenalty;
const OTHER_CONTAINER_PENALTY = D.container.otherPenalty;
const SIZE_TOO_SMALL_PENALTY = D.size.tooSmallPenalty;
const SIZE_TOO_LARGE_LIVE_PENALTY = D.size.tooLargeLivePenalty;
const LANGUAGE_MATCH_BONUS = D.language.matchBonus;
const LANGUAGE_MISMATCH_PENALTY = D.language.mismatchPenalty;
const PREPARED_ONLY_PENALTY = D.release.preparedOnlyPenalty;
const JUNK_SOURCE_PENALTY = D.release.junkPenalty.telesync;

const home = HOME_ENGINE;
/** An engine without tone mapping (home has it on since #27). */
const noTonemap = {
  ...HOME_ENGINE,
  capabilities: { ...HOME_ENGINE.capabilities, tonemap: false },
};

/** A plain 1080p SDR H.264 MKV over HTTP; rows override what they test. */
function cand(
  parsed: Partial<ParsedSource> = {},
  extra: Partial<SourceCandidate> = {},
): SourceCandidate {
  return {
    key: 'k',
    addonId: 'a',
    addonName: 'A',
    kind: 'http',
    name: '',
    title: '',
    parsed: { height: 1080, codec: 'h264', bitDepth: 8, container: 'mkv', ...parsed },
    score: 0,
    playable: true,
    ...extra,
  };
}

describe('rule 1: playability', () => {
  it.each<[string, SourceCandidate, HighResPolicy, object]>([
    [
      'external URL',
      cand({}, { kind: 'external', playable: false, unplayableReason: 'external' }),
      'off',
      { playable: false, unplayableReason: 'external' },
    ],
    [
      'unsupported source stays unsupported',
      cand({}, { playable: false, unplayableReason: 'unsupported' }),
      'on',
      { playable: false, unplayableReason: 'unsupported' },
    ],
    [
      'DV profile 5',
      cand({ hdr: 'dv', dvProfile: 5 }),
      'on',
      { playable: false, unplayableReason: 'dv5' },
    ],
    [
      'DV profile 8 plays',
      cand({ hdr: 'dv', dvProfile: 8 }),
      'off',
      { playable: true, playableWhen: 'live' },
    ],
    [
      'requires another engine',
      cand({}, { requiresEngine: 'alex-pc' }),
      'off',
      { playable: false, unplayableReason: 'other-engine' },
    ],
    [
      'requires this engine',
      cand({}, { requiresEngine: 'home' }),
      'off',
      { playable: true, playableWhen: 'live' },
    ],
    [
      'above liveMaxHeight, highRes off',
      cand({ height: 2160 }),
      'off',
      { playable: false, unplayableReason: 'too-high' },
    ],
    [
      'above liveMaxHeight, prepareOnly',
      cand({ height: 2160 }),
      'prepareOnly',
      { playable: true, playableWhen: 'prepared' },
    ],
    [
      'above liveMaxHeight, on',
      cand({ height: 2160 }),
      'on',
      { playable: true, playableWhen: 'prepared' },
    ],
    [
      'above preparedMaxHeight: the engine limit wins',
      cand({ height: 4320 }),
      'on',
      { playable: false, unplayableReason: 'too-high' },
    ],
    ['at liveMaxHeight', cand({ height: 1080 }), 'off', { playable: true, playableWhen: 'live' }],
    [
      'unknown height plays live',
      cand({ height: undefined }),
      'off',
      { playable: true, playableWhen: 'live' },
    ],
  ])('%s', (_label, candidate, highRes, expected) => {
    expect(playability(candidate, home, highRes)).toEqual(expected);
  });

  it('annotate resets engine-dependent reasons when re-run for another policy', () => {
    const [off] = annotate([cand({ height: 2160 })], home, 'off', defaults);
    expect(off).toMatchObject({ playable: false, unplayableReason: 'too-high' });
    const [again] = annotate([must(off)], home, 'prepareOnly', defaults);
    expect(again).toMatchObject({ playable: true, playableWhen: 'prepared' });
    expect(must(again).unplayableReason).toBeUndefined();
  });
});

const score = (
  c: SourceCandidate,
  engine = home,
  when: 'live' | 'prepared' = 'live',
  runtimeSec?: number,
) => scoreCandidate(c, engine, when, { settings: D, runtimeSec });

describe('rules 2–6: scoring, one row per rule', () => {
  it.each<[string, () => number, number]>([
    // Rule 2: source tier.
    [
      'debrid-cached over HTTP',
      () => score(cand({ cached: true })) - score(cand()),
      TIER_DEBRID_CACHED - TIER_HTTP,
    ],
    [
      'HTTP over a healthy torrent (10 seeders)',
      () => score(cand()) - score(cand({ seeders: 10 }, { kind: 'torrent' })),
      TIER_HTTP - TIER_HEALTHY_TORRENT - 100,
    ],
    [
      'healthy torrent over weak torrent',
      () =>
        score(cand({ seeders: 10 }, { kind: 'torrent' })) -
        score(cand({ seeders: 9 }, { kind: 'torrent' })),
      TIER_HEALTHY_TORRENT + 100 - (TIER_WEAK_TORRENT + 180),
    ],
    [
      'more seeders rank higher (log scale, capped)',
      () =>
        score(cand({ seeders: 1000 }, { kind: 'torrent' })) -
        score(cand({ seeders: 10 }, { kind: 'torrent' })),
      200,
    ],
    [
      'unknown seeders count as weak',
      () => score(cand({}, { kind: 'torrent' })),
      TIER_WEAK_TORRENT + 300,
    ],
    [
      'an uncached debrid link counts as weak',
      () => score(cand({ cached: false })),
      TIER_WEAK_TORRENT + 300,
    ],
    // Rule 3: SDR preferred.
    [
      'HDR10 without tone mapping',
      () => score(cand(), noTonemap) - score(cand({ hdr: 'hdr10', bitDepth: 8 }), noTonemap),
      HDR_PENALTY_NO_TONEMAP,
    ],
    [
      'HLG without tone mapping',
      () => score(cand(), noTonemap) - score(cand({ hdr: 'hlg', bitDepth: 8 }), noTonemap),
      HDR_PENALTY_NO_TONEMAP,
    ],
    [
      'HDR10 with tone mapping, live',
      () => score(cand(), home) - score(cand({ hdr: 'hdr10+', bitDepth: 8 }), home),
      HDR_TONEMAP_COST_LIVE,
    ],
    [
      'HDR10 with tone mapping, prepared',
      () =>
        score(cand({ height: 2160 }), home, 'prepared') -
        score(cand({ height: 2160, hdr: 'hdr10', bitDepth: 8 }), home, 'prepared'),
      HDR_TONEMAP_COST_PREPARED,
    ],
    [
      'DV without a stated profile costs extra',
      () => score(cand({ hdr: 'dv', dvProfile: 8 })) - score(cand({ hdr: 'dv' })),
      DV_UNKNOWN_PROFILE_PENALTY,
    ],
    // Rule 4: decode cost.
    [
      '8-bit H.264 over 8-bit HEVC',
      () => score(cand()) - score(cand({ codec: 'hevc' })),
      DECODE_COST.hevc_8bit,
    ],
    [
      '8-bit HEVC over 10-bit HEVC',
      () => score(cand({ codec: 'hevc' })) - score(cand({ codec: 'hevc', bitDepth: 10 })),
      DECODE_COST.hevc_10bit - DECODE_COST.hevc_8bit,
    ],
    [
      '10-bit HEVC over AV1',
      () =>
        score(cand({ codec: 'hevc', bitDepth: 10 })) - score(cand({ codec: 'av1', bitDepth: 10 })),
      DECODE_COST.av1 - DECODE_COST.hevc_10bit,
    ],
    // Rule 5: container.
    [
      'MPEG-TS live penalty',
      () => score(cand()) - score(cand({ container: 'ts' })),
      MPEGTS_LIVE_PENALTY,
    ],
    [
      'M2TS live penalty',
      () => score(cand()) - score(cand({ container: 'm2ts' })),
      MPEGTS_LIVE_PENALTY,
    ],
    [
      'no MPEG-TS penalty once prepared',
      () => score(cand(), home, 'prepared') - score(cand({ container: 'ts' }), home, 'prepared'),
      0,
    ],
    [
      'MKV/MP4 over other containers',
      () => score(cand({ container: 'mp4' })) - score(cand({ container: 'avi' })),
      OTHER_CONTAINER_PENALTY,
    ],
    // Rule 6: size sanity and language.
    [
      'too small for the runtime',
      () =>
        score(cand({ sizeBytes: 5e8 }), home, 'live', 7200) -
        score(cand({ sizeBytes: 5e8 }), home, 'live', 1200),
      -SIZE_TOO_SMALL_PENALTY,
    ],
    [
      'too small without any runtime',
      () => score(cand({ sizeBytes: 5e7 })) - score(cand({ sizeBytes: 5e9 })),
      -SIZE_TOO_SMALL_PENALTY,
    ],
    [
      'very high bitrate live',
      () =>
        score(cand({ sizeBytes: 60e9, durationSec: 7200 })) -
        score(cand({ sizeBytes: 6e9, durationSec: 7200 })),
      -SIZE_TOO_LARGE_LIVE_PENALTY,
    ],
    [
      'preferred language present',
      () => score(cand({ languages: ['ita', 'eng'] })) - score(cand()),
      LANGUAGE_MATCH_BONUS,
    ],
    [
      'preferred language absent',
      () => score(cand({ languages: ['ita'] })) - score(cand()),
      -LANGUAGE_MISMATCH_PENALTY,
    ],
    ['multi audio is neutral', () => score(cand({ languages: ['fre', 'mul'] })) - score(cand()), 0],
    // Additions: resolution, prepared-only, junk sources.
    ['1080p over 720p', () => score(cand()) - score(cand({ height: 720 })), 100],
    [
      'prepared-only below the same file live',
      () => score(cand({ height: 1080 })) - score(cand({ height: 2160 }), home, 'prepared'),
      PREPARED_ONLY_PENALTY,
    ],
    [
      'CAM and telesync sink',
      () => score(cand()) - score(cand({ source: 'telesync' })),
      JUNK_SOURCE_PENALTY,
    ],
  ])('%s', (_label, delta, expected) => {
    expect(delta()).toBe(expected);
  });

  it('uses the configured preferred language', () => {
    const c = cand({ languages: ['ita'] });
    expect(scoreCandidate(c, home, 'live', { settings: D, preferredLanguages: ['ita'] })).toBe(
      score(c) + LANGUAGE_MATCH_BONUS + LANGUAGE_MISMATCH_PENALTY,
    );
  });

  it('scores a later preferred language below the first, above a mismatch', () => {
    const langs = { settings: D, preferredLanguages: ['ita', 'eng'] };
    const first = scoreCandidate(cand({ languages: ['ita'] }), home, 'live', langs);
    const second = scoreCandidate(cand({ languages: ['eng'] }), home, 'live', langs);
    const neither = scoreCandidate(cand({ languages: ['fre'] }), home, 'live', langs);
    expect(first - second).toBe(D.language.matchBonus - D.language.secondaryMatchBonus);
    expect(second - neither).toBe(D.language.secondaryMatchBonus + D.language.mismatchPenalty);
  });

  it('adds the binge bonus only for the preferred bingeGroup', () => {
    const group = 'torrentio|1080p|WEB-DL';
    const same = cand({}, { bingeGroup: group });
    const other = cand({}, { bingeGroup: 'torrentio|720p|HDTV' });
    const prefer = { settings: D, preferBingeGroup: group };
    expect(scoreCandidate(same, home, 'live', prefer) - score(same)).toBe(D.binge.matchBonus);
    expect(scoreCandidate(other, home, 'live', prefer)).toBe(score(other));
    expect(scoreCandidate(cand(), home, 'live', prefer)).toBe(score(cand()));
  });
});

describe('annotate and sortByRank', () => {
  it('keeps addon order, and sortByRank puts playable first, then score, stable', () => {
    const list = [
      cand({ height: 2160 }, { key: 'uhd' }),
      cand({ height: 720 }, { key: '720' }),
      cand({}, { key: '1080' }),
      cand({}, { key: '1080b' }),
      cand({}, { key: 'ext', kind: 'external', playable: false, unplayableReason: 'external' }),
    ];
    const annotated = annotate(list, home, 'off', defaults);
    expect(annotated.map((c) => c.key)).toEqual(['uhd', '720', '1080', '1080b', 'ext']);
    expect(sortByRank(annotated).map((c) => c.key)).toEqual(['1080', '1080b', '720', 'uhd', 'ext']);
    expect(must(list[0]).score).toBe(0); // inputs untouched
  });
});

function annotated(addon: RealAddon, file: string, highRes: HighResPolicy, engine = home) {
  const candidates = toCandidates({ id: addon, name: addon }, realStreams(addon, file)).map(
    (c) => c.candidate,
  );
  return annotate(candidates, engine, highRes, defaults);
}

describe('ordering on real fixtures (home engine)', () => {
  it('a 1080p SDR debrid-cached H.264 outranks a 2160p DV remux', () => {
    const ranked = sortByRank(
      annotated('torrentio-rd', 'stream-movie-tt0111161.json', 'prepareOnly'),
    );
    const top = must(ranked[0]);
    expect(top.parsed).toMatchObject({ height: 1080, codec: 'h264', cached: true });
    expect(top.parsed.hdr).toBeUndefined();
    expect(top.playableWhen).toBe('live');
    const dvRemux = ranked.find((c) => c.parsed.hdr === 'dv' && c.parsed.source === 'remux');
    expect(dvRemux).toBeDefined();
    expect(must(dvRemux).playableWhen).toBe('prepared');
    expect(ranked.indexOf(must(dvRemux))).toBeGreaterThan(0);
    expect(must(dvRemux).score).toBeLessThan(top.score);
  });

  it('4K is playable only when prepared, and only with prepareOnly', () => {
    for (const [policy, expected] of [
      ['prepareOnly', { playable: true, playableWhen: 'prepared' }],
      ['off', { playable: false, unplayableReason: 'too-high' }],
    ] as const) {
      const uhd = annotated('torrentio-rd', 'stream-movie-tt0111161.json', policy).filter(
        (c) => c.parsed.height === 2160,
      );
      expect(uhd.length).toBeGreaterThan(0);
      for (const c of uhd) expect(c).toMatchObject(expected);
    }
    // Unplayable ones sort after every playable one.
    const ranked = sortByRank(annotated('torrentio-rd', 'stream-movie-tt0111161.json', 'off'));
    const firstUnplayable = ranked.findIndex((c) => !c.playable);
    expect(ranked.slice(firstUnplayable).every((c) => !c.playable)).toBe(true);
  });

  it('DV profile 5 is unplayable', () => {
    const [real] = realStreams('torrentio-rd', 'stream-movie-tt0110912.json');
    const dv5 = StreamSchema.parse({
      ...real,
      behaviorHints: { filename: 'Pulp.Fiction.1994.2160p.WEB-DL.DV.P5.HEVC-G.mkv' },
    });
    const [c] = annotate(
      toCandidates({ id: 'x', name: 'x' }, [dv5]).map((o) => o.candidate),
      home,
      'on',
      defaults,
    );
    expect(c).toMatchObject({ playable: false, unplayableReason: 'dv5' });
  });

  it('across addons: cached first, and HTTP beats public torrents', () => {
    const file = 'stream-movie-tt0816692.json';
    const all = [
      ...annotated('torrentio-public', file, 'prepareOnly'),
      ...annotated('easynews', file, 'prepareOnly'),
      ...annotated('torrentio-rd', file, 'prepareOnly'),
    ];
    const ranked = sortByRank(all);
    expect(must(ranked[0]).parsed.cached).toBe(true);
    const best = (id: string) =>
      Math.max(...all.filter((c) => c.addonId === id && c.playable).map((c) => c.score));
    expect(best('easynews')).toBeGreaterThan(best('torrentio-public'));
  });

  it('never ranks a CAM or telesync above a healthy proper release', () => {
    const all = annotated('torrentio-public', 'stream-movie-tt10872600.json', 'off');
    const junk = all.filter((c) => c.parsed.source === 'telesync' || c.parsed.source === 'cam');
    const proper = all.filter(
      (c) =>
        c.playable &&
        c.parsed.source === 'bluray' &&
        (c.parsed.seeders ?? 0) >= 10 &&
        c.parsed.hdr === undefined,
    );
    if (junk.length > 0 && proper.length > 0) {
      expect(Math.max(...junk.map((c) => c.score))).toBeLessThan(
        Math.min(...proper.map((c) => c.score)),
      );
    }
  });
});

describe('bingeGroup on real fixtures (okf:decision/auto-select-and-fallback auto-next)', () => {
  const FILE = 'stream-series-tt0903747_1_1.json';
  const list = (highRes: HighResPolicy, preferBingeGroup?: string) => {
    const candidates = toCandidates(
      { id: 'torrentio-public', name: 'Torrentio' },
      realStreams('torrentio-public', FILE),
    ).map((c) => c.candidate);
    return sortByRank(annotate(candidates, home, highRes, { settings: D, preferBingeGroup }));
  };

  it("carries the stream's behaviorHints.bingeGroup", () => {
    const all = list('off');
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((c) => c.bingeGroup?.startsWith('torrentio|') === true)).toBe(true);
  });

  it("puts the previous episode's release first among playable candidates", () => {
    const plain = list('off');
    const playable = plain.filter((c) => c.playable);
    // The lowest-ranked playable release, so the bonus has to move it.
    const last = must(playable.at(-1));
    const group = must(last.bingeGroup);
    expect(plain[0]?.bingeGroup).not.toBe(group);
    const ranked = list('off', group);
    expect(must(ranked[0]).bingeGroup).toBe(group);
    expect(must(ranked[0]).score - last.score).toBe(D.binge.matchBonus);
  });

  it('never makes an unplayable release playable', () => {
    const unplayable = must(list('off').find((c) => !c.playable && c.bingeGroup !== undefined));
    const ranked = list('off', unplayable.bingeGroup);
    const same = must(ranked.find((c) => c.key === unplayable.key));
    expect(same.playable).toBe(false);
    expect(must(ranked[0]).playable).toBe(true);
    expect(ranked.indexOf(same)).toBeGreaterThan(ranked.findIndex((c) => !c.playable) - 1);
  });
});

describe('settings', () => {
  it('an unknown Dolby Vision profile ranks below the same release with profile 8 or none', () => {
    const release = { height: 1080, codec: 'hevc', bitDepth: 10 } as const;
    for (const engine of [home, noTonemap]) {
      const unknown = score(cand({ ...release, hdr: 'dv' }), engine);
      const p8 = score(cand({ ...release, hdr: 'dv', dvProfile: 8 }), engine);
      const hdr10 = score(cand({ ...release, hdr: 'hdr10' }), engine);
      const sdr = score(cand(release), engine);
      expect(unknown).toBeLessThan(p8);
      expect(unknown).toBeLessThan(hdr10);
      expect(unknown).toBeLessThan(sdr);
      // By about a tier: phase 0 raised it from 200.
      expect(p8 - unknown).toBe(DV_UNKNOWN_PROFILE_PENALTY);
      expect(DV_UNKNOWN_PROFILE_PENALTY).toBeGreaterThanOrEqual(TIER_HTTP - TIER_HEALTHY_TORRENT);
    }
  });

  it('a changed weight changes the order', () => {
    const list = [
      cand({}, { key: 'http' }),
      cand({ seeders: 500 }, { key: 'torrent', kind: 'torrent' }),
    ];
    const order = (settings: RankingSettings) =>
      sortByRank(annotate(list, home, 'off', { settings })).map((c) => c.key);
    expect(order(D)).toEqual(['http', 'torrent']);
    expect(order(mergeRankingSettings(D, { tiers: { healthyTorrent: 3500 } }))).toEqual([
      'torrent',
      'http',
    ]);
  });

  it('size limits are MB per minute per resolution, with the same effective defaults', () => {
    // 1080p minimum 11.25 MB/min (1.5 Mb/s): a 60-minute episode needs 675 MB.
    const at = (sizeBytes: number, height: number, settings = D) =>
      scoreCandidate(cand({ sizeBytes, height }), home, 'live', { settings, runtimeSec: 3600 });
    expect(at(676e6, 1080) - at(674e6, 1080)).toBe(SIZE_TOO_SMALL_PENALTY);
    // 720p's minimum is lower: the same file is fine there.
    expect(at(674e6, 720) - at(676e6, 720)).toBe(0);
    // Maximum 300 MB/min (40 Mb/s) live: 18 GB an hour.
    expect(at(17.9e9, 1080) - at(18.1e9, 1080)).toBe(SIZE_TOO_LARGE_LIVE_PENALTY);
    // A tighter operator limit for 1080p only.
    const tight = mergeRankingSettings(D, {
      size: { perResolution: { '1080p': { maxMbPerMinute: 100 } } },
    });
    expect(at(6.1e9, 1080, tight) - at(5.9e9, 1080, tight)).toBe(-SIZE_TOO_LARGE_LIVE_PENALTY);
    expect(at(6.1e9, 720, tight) - at(5.9e9, 720, tight)).toBe(0);
    // Without any runtime, the floor stays.
    const noRuntime = (sizeBytes: number) =>
      scoreCandidate(cand({ sizeBytes }), home, 'live', { settings: D });
    expect(noRuntime(101 * 1024 ** 2) - noRuntime(99 * 1024 ** 2)).toBe(SIZE_TOO_SMALL_PENALTY);
  });
});

describe('explain', () => {
  const sum = (c: SourceCandidate) =>
    (c.explain?.contributions ?? []).reduce((a, x) => a + x.points, 0);

  it('is absent by default and leaves the annotation unchanged', () => {
    const [plain] = annotate([cand()], home, 'off', defaults);
    const [explained] = annotate([cand()], home, 'off', { ...defaults, explain: true });
    expect(plain).not.toHaveProperty('explain');
    const { explain, ...rest } = must(explained);
    expect(rest).toEqual(plain);
    expect(explain?.playability).toEqual({ playable: true, playableWhen: 'live' });
  });

  it('contributions sum exactly to the score for every fixture candidate and settings', () => {
    const tweaked = mergeRankingSettings(D, {
      tiers: { http: 1234, healthyTorrent: 3500 },
      language: { matchBonus: 77 },
      hdr: { tonemapCostLive: 13 },
    });
    const files: [RealAddon, string][] = [['torrentio-rd', 'stream-movie-tt0111161.json']];
    for (const settings of [D, tweaked]) {
      for (const engine of [home, noTonemap]) {
        for (const highRes of ['off', 'prepareOnly'] as const) {
          for (const [addon, file] of files) {
            const list = toCandidates({ id: addon, name: addon }, realStreams(addon, file)).map(
              (c) => c.candidate,
            );
            const out = annotate(list, engine, highRes, {
              settings,
              explain: true,
              preferredLanguages: ['ita', 'eng'],
            });
            expect(out.length).toBeGreaterThan(0);
            for (const c of out) expect(sum(c)).toBe(c.score);
          }
        }
      }
    }
  });

  it('names the rules, the weights used and the playability reason', () => {
    const [c] = annotate(
      [cand({ hdr: 'dv', codec: 'hevc', bitDepth: 10, height: 2160, languages: ['fre'] })],
      noTonemap,
      'off',
      { settings: D, explain: true, preferBingeGroup: 'g' },
    );
    const rules = must(c).explain?.contributions.map((x) => x.rule);
    expect(rules).toEqual(['tier', 'hdr', 'decodeCost', 'language', 'resolution']);
    expect(must(c).explain?.weights['tiers.http']).toBe(D.tiers.http);
    expect(must(c).explain?.playability).toEqual({ playable: false, unplayableReason: 'too-high' });
    const secondary = must(
      annotate([cand({ languages: ['eng'] })], home, 'off', {
        settings: D,
        explain: true,
        preferredLanguages: ['ita', 'eng'],
      })[0],
    );
    expect(secondary.explain?.contributions.map((x) => x.rule)).toContain('languageSecondary');
    const binge = must(
      annotate([cand({}, { bingeGroup: 'g' })], home, 'off', {
        settings: D,
        explain: true,
        preferBingeGroup: 'g',
      })[0],
    );
    expect(binge.explain?.contributions.find((x) => x.rule === 'binge')?.points).toBe(
      D.binge.matchBonus,
    );
  });
});
