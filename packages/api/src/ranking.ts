/**
 * Ranking settings (okf:concept/ranking-settings): every number the ranking rules use, as
 * an operator-editable setting behind `/v1/admin/ranking`. The rules stay in
 * code (packages/core/src/selection/rank.ts); only overrides are stored, merged
 * over {@link DEFAULT_RANKING_SETTINGS}.
 *
 * Scores are sums of these weights; only their relative sizes matter, and a
 * higher score is better. Penalties and costs are positive numbers that are
 * subtracted. Sizes use MB = 10^6 bytes, so the defaults equal phase 1's
 * bitrate limits exactly (1 Mb/s = 7.5 MB per minute).
 */
import { z } from 'zod';

/** Upper bound for any single weight, so a typo can't dwarf every other rule by orders of magnitude. */
export const RANKING_MAX_WEIGHT = 1_000_000;

const weight = z.number().min(0).max(RANKING_MAX_WEIGHT);
const mbPerMinute = z.number().min(0).max(100_000);

// ---- Groups ---------------------------------------------------------------------------

export const RankingTiersSchema = z
  .object({
    debridCached: weight.meta({ description: 'Debrid-cached: instant and fast.' }),
    http: weight.meta({ description: 'Plain HTTP (direct links), YouTube, live channels.' }),
    healthyTorrent: weight.meta({
      description: 'A torrent with at least `healthySeeders` seeders.',
    }),
    weakTorrent: weight.meta({
      description: 'A torrent with few or unknown seeders.',
    }),
    healthySeeders: z.number().int().min(0).max(1_000_000),
    seedersLogPoints: weight.meta({ description: 'Healthy torrents: + this × log10(seeders)…' }),
    seedersMaxPoints: weight.meta({ description: '…capped at this.' }),
    weakSeederPoints: weight.meta({ description: 'Weak torrents: + this per seeder.' }),
  })
  .meta({ id: 'RankingTiers' });

export const RankingHdrSchema = z
  .object({
    noTonemapPenalty: weight.meta({ description: 'HDR on an engine without tone mapping.' }),
    tonemapCostLive: weight.meta({ description: 'Tone mapping CPU cost, live sessions.' }),
    tonemapCostPrepared: weight.meta({ description: 'Tone mapping CPU cost, prepared sessions.' }),
    dvUnknownProfilePenalty: weight.meta({
      description: 'Dolby Vision with no stated profile (might be profile 5).',
    }),
  })
  .meta({ id: 'RankingHdr' });

export const RankingDecodeCostSchema = z
  .object({
    h264_8bit: weight,
    h264_10bit: weight,
    hevc_8bit: weight,
    hevc_10bit: weight,
    vp9: weight,
    av1: weight,
    legacy: weight.meta({ description: 'MPEG-2, Xvid, VC-1.' }),
    unknown: weight.meta({ description: 'Codec not stated.' }),
  })
  .meta({ id: 'RankingDecodeCost' });

export const RankingContainerSchema = z
  .object({
    mpegtsLivePenalty: weight.meta({ description: 'MPEG-TS (`.ts`, `.m2ts`) on a live session.' }),
    otherPenalty: weight.meta({ description: 'Anything but MKV/MP4 (and MPEG-TS once prepared).' }),
  })
  .meta({ id: 'RankingContainer' });

export const SizeRangeSchema = z
  .object({
    minMbPerMinute: mbPerMinute.meta({ description: 'Below this is implausibly small.' }),
    maxMbPerMinute: mbPerMinute.meta({ description: 'Above this is too large to fetch live.' }),
  })
  .meta({ id: 'SizeRange' });
export type SizeRange = z.infer<typeof SizeRangeSchema>;

/** Resolution classes for size limits: a height at or above the class's floor uses it. */
export const SIZE_CLASSES = ['2160p', '1080p', '720p', 'sd'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];
/** Height floor of each size class. */
export const SIZE_CLASS_MIN_HEIGHT: Record<SizeClass, number> = {
  '2160p': 2160,
  '1080p': 1080,
  '720p': 720,
  sd: 0,
};

export const RankingSizeSchema = z
  .object({
    perResolution: z
      .object({
        '2160p': SizeRangeSchema,
        '1080p': SizeRangeSchema,
        '720p': SizeRangeSchema,
        sd: SizeRangeSchema.meta({ description: 'Below 720p, or unknown.' }),
      })
      .meta({ description: 'MB per minute of runtime, per resolution (the *arrs’ model).' }),
    tooSmallPenalty: weight,
    tooLargeLivePenalty: weight,
    noRuntimeMinMiB: z.number().min(0).max(1_000_000).meta({
      description: 'Without any runtime, a file smaller than this (MiB) counts as too small.',
    }),
  })
  .meta({ id: 'RankingSize' });

export const RankingLanguageSchema = z
  .object({
    matchBonus: weight.meta({ description: 'The first preferred audio language is present.' }),
    secondaryMatchBonus: weight.meta({
      description:
        "Not the first preferred language, but a later one in the request's list is present.",
    }),
    mismatchPenalty: weight.meta({
      description: 'Languages are known and none of the preferred ones is among them.',
    }),
  })
  .meta({ id: 'RankingLanguage' });

export const RankingBingeSchema = z
  .object({
    matchBonus: weight.meta({
      description:
        "The candidate's `bingeGroup` equals the request's `preferBingeGroup` (the release the previous episode played). Strong, but below the mismatch penalties, and it never makes an unplayable candidate playable.",
    }),
  })
  .meta({ id: 'RankingBinge' });

export const RankingLastSourceSchema = z
  .object({
    matchBonus: weight.meta({
      description:
        "The candidate is the source the request's profile last played for this video (`lastUsed`). Above any tier difference, and with `binge.matchBonus` still below the episode mismatch penalty; it never makes an unplayable candidate playable.",
    }),
  })
  .meta({ id: 'RankingLastSource' });

/** Resolution classes for points, capped at the engine's `liveMaxHeight`. */
export const RESOLUTION_CLASSES = ['2160p', '1080p', '720p', '480p', 'lower'] as const;
export type ResolutionClass = (typeof RESOLUTION_CLASSES)[number];
export const RESOLUTION_CLASS_MIN_HEIGHT: Record<ResolutionClass, number> = {
  '2160p': 2160,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  lower: 0,
};

export const RankingResolutionSchema = z
  .object({
    points: z.object({
      '2160p': weight,
      '1080p': weight,
      '720p': weight,
      '480p': weight,
      lower: weight,
    }),
    unknownPoints: weight.meta({ description: 'Height unknown (usually an old SD release).' }),
  })
  .meta({ id: 'RankingResolution' });

export const RankingReleaseSchema = z
  .object({
    junkPenalty: z
      .object({
        cam: weight,
        telesync: weight,
        telecine: weight,
        screener: weight,
        workprint: weight,
      })
      .meta({ description: 'Pre-release junk, per type.' }),
    preparedOnlyPenalty: weight.meta({ description: 'Plays only once prepared.' }),
    episodeMismatchPenalty: weight.meta({
      description: 'Same show, another episode (rule 7): below every matching playable candidate.',
    }),
    titleMismatchPenalty: weight.meta({ description: 'A different title (rule 7): the heaviest.' }),
  })
  .meta({ id: 'RankingRelease' });

export const RankingDebridSchema = z
  .object({
    uncachedPenalty: weight.meta({
      description:
        "Subtracted from a debrid source the addon marks as not cached (`parsed.cached: false`: Torrentio's `[RD download]`, MediaFusion's ⏳). It still plays, after the debrid service fetches it, so it ranks below healthy cached and torrent sources but is not excluded.",
    }),
  })
  .meta({ id: 'RankingDebrid' });

/** Longest safety pattern or id prefix. */
export const SAFETY_PATTERN_MAX_LENGTH = 200;
/** Most safety patterns or id prefixes. */
export const SAFETY_MAX_ENTRIES = 100;

const safetyEntry = z.string().min(1).max(SAFETY_PATTERN_MAX_LENGTH).regex(/\S/);

export const RankingSafetySchema = z
  .object({
    titlePatterns: z
      .array(safetyEntry)
      .max(SAFETY_MAX_ENTRIES)
      .meta({
        description:
          "Plain phrases, not regular expressions, matched case-insensitively as whole words against a catalog item's or meta's name and a source's name and description. A match flags the item or source `destructive`: auto-select never picks it.",
        example: ['delete all', 'wipe'],
      }),
    idPrefixes: z
      .array(safetyEntry)
      .max(SAFETY_MAX_ENTRIES)
      .meta({
        description:
          'Item ids starting with one of these (case-sensitive) are flagged `destructive`, and so is every source listed for them.',
        example: ['someaddondelete'],
      }),
  })
  .meta({
    id: 'RankingSafety',
    description:
      "Some addons list actions as items (a debrid account's `delete all files` entry). Flagged items and sources are annotated (`flags`), never auto-selected; an explicitly picked one still plays.",
  });
export type RankingSafety = z.infer<typeof RankingSafetySchema>;

// ---- The whole document -------------------------------------------------------------

export const RankingSettingsSchema = z
  .object({
    tiers: RankingTiersSchema,
    hdr: RankingHdrSchema,
    decodeCost: RankingDecodeCostSchema,
    container: RankingContainerSchema,
    size: RankingSizeSchema,
    language: RankingLanguageSchema,
    resolution: RankingResolutionSchema,
    release: RankingReleaseSchema,
    binge: RankingBingeSchema,
    lastSource: RankingLastSourceSchema,
    debrid: RankingDebridSchema,
    safety: RankingSafetySchema,
  })
  .strict()
  .meta({ id: 'RankingSettings' });
export type RankingSettings = z.infer<typeof RankingSettingsSchema>;

/**
 * Groups added after the first presets were shared. A `PUT` may leave them out
 * (they take the defaults), so a preset saved before they existed still
 * imports; `GET` always shows them.
 */
export const RANKING_LATER_GROUPS = ['binge', 'lastSource', 'debrid', 'safety'] as const;

/** Body of `PUT /v1/admin/ranking`: a complete document, except that later groups may be missing. */
export const RankingSettingsInputSchema = RankingSettingsSchema.extend({
  binge: RankingBingeSchema.optional(),
  lastSource: RankingLastSourceSchema.optional(),
  debrid: RankingDebridSchema.optional(),
  safety: RankingSafetySchema.optional(),
})
  .strict()
  .meta({
    id: 'RankingSettingsInput',
    description:
      'A complete `RankingSettings` document. `binge`, `lastSource`, `debrid` and `safety` may be left out (older presets): they take the defaults.',
  });
export type RankingSettingsInput = z.infer<typeof RankingSettingsInputSchema>;

/** A partial document for `PATCH` and for the stored overrides: every group and field optional. */
export type RankingSettingsPatch = {
  [G in keyof RankingSettings]?: DeepPartial<RankingSettings[G]>;
};
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function deepPartial(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const partial = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => [key, deepPartial(value).optional()]),
    );
    return z.object(partial).strict();
  }
  return schema;
}

export const RankingSettingsPatchSchema = (
  deepPartial(RankingSettingsSchema) as z.ZodType<RankingSettingsPatch>
).meta({
  id: 'RankingSettingsPatch',
  description: 'Any subset of `RankingSettings`; unknown fields are rejected.',
});

export const RankingSettingsViewSchema = z
  .object({
    effective: RankingSettingsSchema.meta({ description: 'What ranking uses now.' }),
    defaults: RankingSettingsSchema.meta({ description: "Multitap's built-in values." }),
    overrides: RankingSettingsPatchSchema.meta({ description: 'Only what an operator changed.' }),
  })
  .meta({ id: 'RankingSettingsView' });
export type RankingSettingsView = z.infer<typeof RankingSettingsViewSchema>;

/** 1 Mb/s of average bitrate as MB (10^6 bytes) per minute. */
export const MB_PER_MINUTE_PER_MBPS = 60 / 8;

/**
 * The built-in values: phase 1's constants from rank.ts, except the unknown
 * Dolby Vision profile penalty (raised in phase 2, below). Phase 1's
 * minimum bitrates (4, 1.5, 0.8, 0.3 Mb/s) and its single 40 Mb/s live maximum
 * become per-resolution MB-per-minute ranges. The mismatch penalties (rule 7)
 * are new in phase 2.
 */
export const DEFAULT_RANKING_SETTINGS: RankingSettings = {
  tiers: {
    debridCached: 4000,
    http: 3000,
    healthyTorrent: 2000,
    weakTorrent: 1000,
    healthySeeders: 10,
    seedersLogPoints: 100,
    seedersMaxPoints: 300,
    weakSeederPoints: 20,
  },
  hdr: {
    noTonemapPenalty: 1500,
    tonemapCostLive: 300,
    tonemapCostPrepared: 100,
    // Phase 0: an unknown profile may be profile 5 (wrong colours). Raised from
    // phase 1's 200 to the size of a tier: such a release ranks well below the
    // same release with a stated profile 8 or without Dolby Vision.
    dvUnknownProfilePenalty: 1000,
  },
  decodeCost: {
    h264_8bit: 0,
    h264_10bit: 150,
    hevc_8bit: 100,
    hevc_10bit: 200,
    vp9: 300,
    av1: 400,
    legacy: 50,
    unknown: 150,
  },
  container: { mpegtsLivePenalty: 150, otherPenalty: 25 },
  size: {
    perResolution: {
      // 4, 1.5, 0.8 and 0.3 Mb/s minimum; 40 Mb/s maximum.
      '2160p': { minMbPerMinute: 30, maxMbPerMinute: 300 },
      '1080p': { minMbPerMinute: 11.25, maxMbPerMinute: 300 },
      '720p': { minMbPerMinute: 6, maxMbPerMinute: 300 },
      sd: { minMbPerMinute: 2.25, maxMbPerMinute: 300 },
    },
    tooSmallPenalty: 300,
    tooLargeLivePenalty: 100,
    noRuntimeMinMiB: 100,
  },
  language: { matchBonus: 100, secondaryMatchBonus: 50, mismatchPenalty: 200 },
  resolution: {
    points: { '2160p': 300, '1080p': 300, '720p': 200, '480p': 100, lower: 0 },
    unknownPoints: 100,
  },
  release: {
    junkPenalty: {
      cam: 2500,
      telesync: 2500,
      telecine: 2500,
      screener: 2500,
      workprint: 2500,
    },
    preparedOnlyPenalty: 200,
    episodeMismatchPenalty: 10_000,
    titleMismatchPenalty: 20_000,
  },
  // More than any tier difference (debrid-cached over a weak torrent is 3000),
  // so the previous episode's release wins when it plays; below the episode
  // mismatch penalty, so a wrong file of that release still sinks.
  binge: { matchBonus: 5000 },
  // The exact stream played last for this video: above any tier difference
  // (3000 plus seeder points). With the binge bonus (the same stream usually
  // shares its group) 9000, still below the episode mismatch penalty.
  lastSource: { matchBonus: 4000 },
  // An uncached debrid link is an HTTP source (tier 3000) that first needs a
  // debrid download: 1000 net, below a healthy torrent (2000+) and as low as a
  // weak one. The same score phase 2 gave Torrentio's `[RD download]`.
  debrid: { uncachedPenalty: 2000 },
  safety: {
    titlePatterns: ['delete all', 'remove all', 'clear all', 'wipe', 'purge all', 'format'],
    idPrefixes: [],
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges stored or patched overrides over a complete document, returning a new
 * one. Objects merge key by key; anything else replaces.
 */
export function mergeRankingSettings(
  base: RankingSettings,
  overrides: RankingSettingsPatch,
): RankingSettings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = merge(a[key], value);
    return out;
  };
  return merge(base, overrides) as RankingSettings;
}
