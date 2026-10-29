/**
 * `selection/rank`: annotates candidates for one engine (okf:concept/source-ranking).
 *
 * `annotate` decides `playable`, `unplayableReason`, `playableWhen` and
 * `score`, and keeps the addon order. `sortByRank` is the `sort=rank` order.
 * The rules live here; every number they use comes from the effective
 * {@link RankingSettings} the caller passes (`/v1/admin/ranking`, defaults in
 * `@multitap/api`). Scores are sums of those weights; only their relative
 * sizes matter, and a higher score is better.
 */
import {
  RESOLUTION_CLASSES,
  RESOLUTION_CLASS_MIN_HEIGHT,
  SIZE_CLASSES,
  SIZE_CLASS_MIN_HEIGHT,
  type EngineDescriptor,
  type HighResPolicy,
  type ParsedSource,
  type RankingSettings,
  type ReleaseSource,
  type SizeRange,
  type SourceExplain,
  type SourceCandidate,
  type UnplayableReason,
} from '@multitap/api';
import { mismatchOf, type MatchTarget, type Mismatch } from './match.ts';
import { flagsOf, sourceFlagReasons, type FlagReason } from './safety.ts';

export interface RankOptions {
  /** The effective ranking settings (defaults merged with the operator's overrides). */
  settings: RankingSettings;
  /**
   * Preferred audio languages as ISO 639-2/B codes, most preferred first
   * (`resolvePreferredLanguages`); default `['eng']`.
   */
  preferredLanguages?: readonly string[] | undefined;
  /** Candidates with this `bingeGroup` get `binge.matchBonus` (auto-next keeps the release). */
  preferBingeGroup?: string | undefined;
  /**
   * The candidate key (`sourceIdentity`) the request's profile last played for
   * this video: it gets `lastSource.matchBonus`.
   */
  lastSource?: string | undefined;
  /** The item's runtime in seconds, when known (its meta's `runtime`), for size sanity. */
  runtimeSec?: number | undefined;
  /**
   * What was asked for, from the item's meta (rule 7). Without it, nothing is
   * scored as a mismatch.
   */
  target?: MatchTarget | undefined;
  /**
   * Why the item itself is flagged (`itemFlagReasons` of its id and meta
   * name): every candidate carries them. A candidate's own name and
   * description are checked against `settings.safety` here.
   */
  itemFlagReasons?: readonly FlagReason[] | undefined;
  /** Attach `explain` (the rules behind the score) to each candidate. Default off. */
  explain?: boolean | undefined;
}

export type RankEngine = Pick<EngineDescriptor, 'id' | 'capabilities'>;

interface Verdict {
  playable: boolean;
  unplayableReason?: UnplayableReason;
  playableWhen?: 'live' | 'prepared';
}

/** Rule 1: can this engine play it, and when. */
export function playability(
  candidate: SourceCandidate,
  engine: RankEngine,
  highRes: HighResPolicy,
): Verdict {
  // Engine-independent reasons from `toCandidate` stand.
  if (candidate.unplayableReason === 'external' || candidate.unplayableReason === 'unsupported') {
    return { playable: false, unplayableReason: candidate.unplayableReason };
  }
  if (candidate.kind === 'external') return { playable: false, unplayableReason: 'external' };
  if (candidate.parsed.dvProfile === 5) return { playable: false, unplayableReason: 'dv5' };
  if (candidate.requiresEngine !== undefined && candidate.requiresEngine !== engine.id) {
    return { playable: false, unplayableReason: 'other-engine' };
  }
  const { height } = candidate.parsed;
  const { liveMaxHeight, preparedMaxHeight } = engine.capabilities;
  if (height === undefined || height <= liveMaxHeight) {
    return { playable: true, playableWhen: 'live' };
  }
  // `on` exists for engines whose live limit is higher; the engine limit still wins.
  if (highRes !== 'off' && height <= preparedMaxHeight) {
    return { playable: true, playableWhen: 'prepared' };
  }
  return { playable: false, unplayableReason: 'too-high' };
}

/**
 * Rule 2: source tier. One tier is worth more than any codec or container
 * difference. A debrid link the addon marks as not cached is tiered by its
 * kind (an HTTP link) and loses `debrid.uncachedPenalty` apart (`uncached`).
 */
function tierScore(candidate: SourceCandidate, tiers: RankingSettings['tiers']): number {
  const { cached, seeders } = candidate.parsed;
  if (cached === true) return tiers.debridCached;
  if (candidate.kind !== 'torrent') return tiers.http;
  if (seeders !== undefined && seeders >= tiers.healthySeeders) {
    // log10 so 1000 seeders beat 20, capped.
    const points = Math.round(tiers.seedersLogPoints * Math.log10(Math.max(1, seeders)));
    return tiers.healthyTorrent + Math.min(tiers.seedersMaxPoints, points);
  }
  return tiers.weakTorrent + tiers.weakSeederPoints * (seeders ?? 0);
}

/**
 * Rule 3: SDR preferred. Without tone mapping HDR looks washed out; with it,
 * only its CPU cost counts (a small engine host may not tone-map large releases live). Dolby Vision
 * without a stated profile might be profile 5, which can't be played.
 */
function hdrPenalty(
  parsed: ParsedSource,
  engine: RankEngine,
  live: boolean,
  hdr: RankingSettings['hdr'],
): number {
  if (parsed.hdr === undefined) return 0;
  let penalty = engine.capabilities.tonemap
    ? live
      ? hdr.tonemapCostLive
      : hdr.tonemapCostPrepared
    : hdr.noTonemapPenalty;
  if (parsed.hdr === 'dv' && parsed.dvProfile === undefined) penalty += hdr.dvUnknownProfilePenalty;
  return penalty;
}

/** Rule 4: decode cost on the engine (software decode today). */
export function decodeCost(parsed: ParsedSource, cost: RankingSettings['decodeCost']): number {
  const tenBit = (parsed.bitDepth ?? 8) >= 10;
  switch (parsed.codec) {
    case 'h264':
      return tenBit ? cost.h264_10bit : cost.h264_8bit;
    case 'hevc':
      return tenBit ? cost.hevc_10bit : cost.hevc_8bit;
    case 'vp9':
      return cost.vp9;
    case 'av1':
      return cost.av1;
    case 'mpeg2':
    case 'xvid':
    case 'vc1':
      return cost.legacy;
    case undefined:
      return cost.unknown;
  }
}

/** Rule 5: MPEG-TS on a live session seeks late on long keyframe intervals (okf:discovery/ffmpeg-mpegts-seek-next-keyframe); prefer MKV/MP4. */
function containerPenalty(
  parsed: ParsedSource,
  live: boolean,
  container: RankingSettings['container'],
): number {
  const c = parsed.container;
  if (c === undefined || c === 'mkv' || c === 'mp4' || c === 'm4v') return 0;
  if (c === 'ts' || c === 'm2ts') return live ? container.mpegtsLivePenalty : 0;
  return container.otherPenalty;
}

/** The size range for a height: the first class whose floor it reaches; unknown is `sd`. */
export function sizeRange(height: number | undefined, size: RankingSettings['size']): SizeRange {
  const h = height ?? 0;
  const cls = SIZE_CLASSES.find((c) => h >= SIZE_CLASS_MIN_HEIGHT[c]) ?? 'sd';
  return size.perResolution[cls];
}

/**
 * Rule 6: size sanity for the runtime (the *arrs' model): MB (10^6 bytes) per
 * minute below the resolution's minimum is implausibly small (fake, or badly
 * compressed); above its maximum is hard to fetch at playback speed live.
 * Without any runtime only a file below the floor is clearly suspicious.
 */
function sizePenalty(
  parsed: ParsedSource,
  live: boolean,
  size: RankingSettings['size'],
  runtimeSec?: number,
): number {
  const { sizeBytes } = parsed;
  if (sizeBytes === undefined) return 0;
  const duration = parsed.durationSec ?? runtimeSec;
  if (duration === undefined || duration <= 0) {
    return sizeBytes < size.noRuntimeMinMiB * 1024 ** 2 ? size.tooSmallPenalty : 0;
  }
  const mbPerMinute = sizeBytes / 1e6 / (duration / 60);
  const range = sizeRange(parsed.height, size);
  if (mbPerMinute < range.minMbPerMinute) return size.tooSmallPenalty;
  if (live && mbPerMinute > range.maxMbPerMinute) return size.tooLargeLivePenalty;
  return 0;
}

/** Rule 6: the preferred audio languages, the first one worth the most. */
function languageScore(
  parsed: ParsedSource,
  preferred: readonly string[],
  language: RankingSettings['language'],
): number {
  const langs = parsed.languages;
  if (langs === undefined || langs.length === 0 || preferred.length === 0) return 0;
  const [first, ...rest] = preferred;
  if (first !== undefined && langs.includes(first)) return language.matchBonus;
  if (rest.some((lang) => langs.includes(lang))) return language.secondaryMatchBonus;
  if (langs.includes('mul')) return 0;
  return -language.mismatchPenalty;
}

/** Rule 8: points by height class, capped at what the engine plays live; unknown is usually old SD. */
function resolutionScore(
  height: number | undefined,
  engine: RankEngine,
  resolution: RankingSettings['resolution'],
): number {
  if (height === undefined) return resolution.unknownPoints;
  const h = Math.min(height, engine.capabilities.liveMaxHeight);
  const cls = RESOLUTION_CLASSES.find((c) => h >= RESOLUTION_CLASS_MIN_HEIGHT[c]) ?? 'lower';
  return resolution.points[cls];
}

type JunkSource = keyof RankingSettings['release']['junkPenalty'];
const JUNK: ReadonlySet<ReleaseSource> = new Set<JunkSource>([
  'cam',
  'telesync',
  'telecine',
  'screener',
  'workprint',
]);

/** Rule 7: a different episode of the same show, or a different title. */
function mismatchPenalty(mismatch: Mismatch | undefined, release: RankingSettings['release']) {
  if (mismatch === 'title') return release.titleMismatchPenalty;
  if (mismatch === 'episode') return release.episodeMismatchPenalty;
  return 0;
}

const DEFAULT_LANGUAGES: readonly string[] = ['eng'];

/** One rule's move of the score, with the named weights behind it (`explain`). */
interface Contribution {
  rule: string;
  points: number;
  detail?: string;
  weights?: Record<string, number>;
}

/**
 * The okf:concept/source-ranking score for a candidate as an ordered list of contributions. Every
 * rule registers through `add`, which drops zero moves; the score is the sum
 * of what was registered, so `explain` cannot disagree with it. A new rule is
 * one more `add` call.
 */
function contributions(
  candidate: SourceCandidate,
  engine: RankEngine,
  playableWhen: 'live' | 'prepared' | undefined,
  options: RankOptions,
): Contribution[] {
  const { settings: s } = options;
  const { parsed } = candidate;
  const live = playableWhen !== 'prepared';
  const out: Contribution[] = [];
  const add = (
    rule: string,
    points: number,
    weights: Record<string, number>,
    detail?: string,
  ): void => {
    if (points === 0) return;
    out.push({ rule, points, ...(detail === undefined ? {} : { detail }), weights });
  };
  add('tier', tierScore(candidate, s.tiers), tierWeights(s.tiers), tierDetail(candidate));
  if (parsed.cached === false) {
    add(
      'uncached',
      -s.debrid.uncachedPenalty,
      { 'debrid.uncachedPenalty': s.debrid.uncachedPenalty },
      'debrid not cached',
    );
  }
  add('hdr', -hdrPenalty(parsed, engine, live, s.hdr), hdrWeights(s.hdr), parsed.hdr);
  add('decodeCost', -decodeCost(parsed, s.decodeCost), {}, parsed.codec ?? 'unknown');
  add('container', -containerPenalty(parsed, live, s.container), {}, parsed.container);
  add('size', -sizePenalty(parsed, live, s.size, options.runtimeSec), {});
  const lang = languageScore(parsed, options.preferredLanguages ?? DEFAULT_LANGUAGES, s.language);
  const secondary = lang > 0 && lang === s.language.secondaryMatchBonus;
  add(secondary ? 'languageSecondary' : 'language', lang, {
    'language.matchBonus': s.language.matchBonus,
    'language.secondaryMatchBonus': s.language.secondaryMatchBonus,
    'language.mismatchPenalty': s.language.mismatchPenalty,
  });
  if (
    options.preferBingeGroup !== undefined &&
    candidate.bingeGroup !== undefined &&
    candidate.bingeGroup === options.preferBingeGroup
  ) {
    add('binge', s.binge.matchBonus, { 'binge.matchBonus': s.binge.matchBonus });
  }
  if (options.lastSource !== undefined && candidate.key === options.lastSource) {
    add('lastSource', s.lastSource.matchBonus, {
      'lastSource.matchBonus': s.lastSource.matchBonus,
    });
  }
  add(
    'resolution',
    resolutionScore(parsed.height, engine, s.resolution),
    {},
    parsed.height === undefined ? 'unknown height' : String(parsed.height) + 'p',
  );
  if (!live) {
    add('preparedOnly', -s.release.preparedOnlyPenalty, {
      'release.preparedOnlyPenalty': s.release.preparedOnlyPenalty,
    });
  }
  if (parsed.source !== undefined && JUNK.has(parsed.source)) {
    add('release', -s.release.junkPenalty[parsed.source as JunkSource], {}, parsed.source);
  }
  if (options.target !== undefined) {
    const mismatch = mismatchOf(candidate, options.target);
    const rule = mismatch === 'title' ? 'titleMismatch' : 'episodeMismatch';
    add(rule, -mismatchPenalty(mismatch, s.release), {
      'release.titleMismatchPenalty': s.release.titleMismatchPenalty,
      'release.episodeMismatchPenalty': s.release.episodeMismatchPenalty,
    });
  }
  return out;
}

function tierDetail(candidate: SourceCandidate): string {
  const { cached } = candidate.parsed;
  if (cached === true) return 'debrid cached';
  if (cached === false) return 'debrid not cached';
  return candidate.kind;
}

function tierWeights(t: RankingSettings['tiers']): Record<string, number> {
  return {
    'tiers.debridCached': t.debridCached,
    'tiers.healthyTorrent': t.healthyTorrent,
    'tiers.weakTorrent': t.weakTorrent,
    'tiers.http': t.http,
  };
}

function hdrWeights(h: RankingSettings['hdr']): Record<string, number> {
  return {
    'hdr.tonemapCostLive': h.tonemapCostLive,
    'hdr.tonemapCostPrepared': h.tonemapCostPrepared,
    'hdr.noTonemapPenalty': h.noTonemapPenalty,
    'hdr.dvUnknownProfilePenalty': h.dvUnknownProfilePenalty,
  };
}

/** The score, and the contributions it is the exact sum of. */
export function scoreWithContributions(
  candidate: SourceCandidate,
  engine: RankEngine,
  playableWhen: 'live' | 'prepared' | undefined,
  options: RankOptions,
): { score: number; contributions: Contribution[] } {
  const list = contributions(candidate, engine, playableWhen, options);
  return { score: list.reduce((sum, c) => sum + c.points, 0), contributions: list };
}

/**
 * The okf:concept/source-ranking score for a candidate on this engine, given when it would play.
 * The binge bonus is part of the score only: playability is decided apart
 * (`playability`), so it never makes an unplayable candidate playable.
 */
export function scoreCandidate(
  candidate: SourceCandidate,
  engine: RankEngine,
  playableWhen: 'live' | 'prepared' | undefined,
  options: RankOptions,
): number {
  return scoreWithContributions(candidate, engine, playableWhen, options).score;
}

/** The public `explain`: contributions in order, merged weights, the playability chain, flags. */
function explainOf(
  moves: readonly Contribution[],
  verdict: Verdict,
  flags: readonly FlagReason[],
): SourceExplain {
  const weights: Record<string, number> = {};
  for (const m of moves) Object.assign(weights, m.weights);
  const playable: SourceExplain['playability'] = { playable: verdict.playable };
  if (verdict.unplayableReason !== undefined) playable.unplayableReason = verdict.unplayableReason;
  if (verdict.playableWhen !== undefined) playable.playableWhen = verdict.playableWhen;
  return {
    contributions: moves.map(({ rule, points, detail }) => ({
      rule,
      points,
      ...(detail === undefined ? {} : { detail }),
    })),
    weights,
    playability: playable,
    ...(flags.length === 0 ? {} : { flags: [...flags] }),
  };
}

/**
 * Annotates every candidate for `engine` and `highRes`, returning new objects
 * in the same (addon) order. Nothing is removed: mismatches only score low,
 * and flagged candidates (`flags`, from `settings.safety`) stay listed.
 */
export function annotate(
  candidates: readonly SourceCandidate[],
  engine: RankEngine,
  highRes: HighResPolicy,
  options: RankOptions,
): SourceCandidate[] {
  return candidates.map((candidate) => {
    const verdict = playability(candidate, engine, highRes);
    const { score, contributions: moves } = scoreWithContributions(
      candidate,
      engine,
      verdict.playableWhen,
      options,
    );
    const out: SourceCandidate = { ...candidate, playable: verdict.playable, score };
    delete out.explain;
    delete out.unplayableReason;
    delete out.playableWhen;
    delete out.flags;
    if (verdict.unplayableReason !== undefined) out.unplayableReason = verdict.unplayableReason;
    if (verdict.playableWhen !== undefined) out.playableWhen = verdict.playableWhen;
    const reasons = sourceFlagReasons(
      candidate,
      options.itemFlagReasons ?? [],
      options.settings.safety,
    );
    const flags = flagsOf(reasons);
    if (flags !== undefined) out.flags = flags;
    if (options.explain === true) out.explain = explainOf(moves, verdict, reasons);
    return out;
  });
}

/**
 * The `sort=rank` order: playable first, then by score, ties in the original
 * order. Returns a new array.
 */
export function sortByRank(candidates: readonly SourceCandidate[]): SourceCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        Number(b.candidate.playable) - Number(a.candidate.playable) ||
        b.candidate.score - a.candidate.score ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
}
