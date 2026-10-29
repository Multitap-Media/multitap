/**
 * Source candidates: the normalized, engine-annotated form of an addon stream
 * (okf:architecture/normalized-addon-types, okf:concept/source-ranking). Clients only ever see these; raw `Stream`s stay
 * in Multitap. Schemas are plain JSON-schema-representable zod (no transforms), so
 * they carry straight into the OpenAPI document.
 */
import { z } from 'zod';

export const HDR_FORMATS = ['hdr10', 'hdr10+', 'dv', 'hlg'] as const;
export type HdrFormat = (typeof HDR_FORMATS)[number];

export const VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vp9', 'mpeg2', 'vc1', 'xvid'] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

/** Where a release came from. `cam` … `workprint` are pre-release junk. */
export const RELEASE_SOURCES = [
  'cam',
  'telesync',
  'telecine',
  'screener',
  'workprint',
  'tv',
  'dvd',
  'web',
  'bluray',
  'remux',
] as const;
export type ReleaseSource = (typeof RELEASE_SOURCES)[number];

export const SOURCE_KINDS = [
  'torrent',
  'http',
  'youtube',
  'live',
  'external',
  'engine-local',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const UNPLAYABLE_REASONS = [
  'external',
  'dv5',
  'other-engine',
  'too-high',
  'unsupported',
] as const;
export type UnplayableReason = (typeof UNPLAYABLE_REASONS)[number];

/**
 * Safety flags on items and sources (`RankingSafety`). `destructive`: it looks
 * like an action rather than media (a debrid account's "delete all files"
 * entry); auto-select never picks it.
 */
export const ITEM_FLAGS = ['destructive'] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

export const ItemFlagsSchema = z
  .array(z.enum(ITEM_FLAGS))
  .min(1)
  .meta({
    id: 'ItemFlags',
    description:
      'Present only when flagged. `destructive`: the name or id matches the `safety` ranking settings, so playing it may trigger an action in an addon or debrid account. Auto-select never picks a flagged source; an explicitly picked one still plays.',
    example: ['destructive'],
  });

export const PLAYABLE_WHEN = ['live', 'prepared'] as const;
export type PlayableWhen = (typeof PLAYABLE_WHEN)[number];

export const HIGH_RES_POLICIES = ['off', 'prepareOnly', 'on'] as const;
export type HighResPolicy = (typeof HIGH_RES_POLICIES)[number];

/** A three-letter language code (ISO 639-2/B, 639-2/T or 639-3); Multitap compares them as 639-2/B. */
export const LANGUAGE_CODE_PATTERN = '^[a-z]{3}$';
/** Most languages a preference list may name. */
export const MAX_PREFERRED_LANGUAGES = 10;
/** Longest `bingeGroup` Multitap keeps; a longer one is dropped. */
export const MAX_BINGE_GROUP_LENGTH = 500;

export const LanguageCodeSchema = z
  .string()
  .regex(new RegExp(LANGUAGE_CODE_PATTERN))
  .meta({ description: 'ISO 639-2 (B or T) or 639-3 code, lowercase.', example: 'eng' });

/**
 * A request's preferred audio languages, most preferred first (okf:concept/source-ranking rule 6).
 * Resolution order: the request's list, else the profile's (`audioLanguage`,
 * `secondaryAudioLanguage`, when the request names a `profileId`), else the
 * instance default `MULTITAP_SELECTION_PREFERRED_LANGUAGE`.
 */
export const PreferredLanguagesSchema = z
  .array(LanguageCodeSchema)
  .min(1)
  .max(MAX_PREFERRED_LANGUAGES)
  .meta({
    id: 'PreferredLanguages',
    description:
      "Preferred audio languages, most preferred first. Overrides the profile's audio languages (with `profileId`) and the instance default (`MULTITAP_SELECTION_PREFERRED_LANGUAGE`) for this request.",
    example: ['ita', 'eng'],
  });

/** What Multitap could read from the release name, the stream's fields and addon conventions. Every field is best-effort. */
export const ParsedSourceSchema = z
  .object({
    height: z.number().int().positive().optional().meta({
      description: 'Vertical resolution class: 480, 720, 1080, 2160, …',
      example: 1080,
    }),
    hdr: z.enum(HDR_FORMATS).optional().meta({
      description: 'Absent means SDR or unknown. Dolby Vision wins over its HDR10 fallback layer.',
    }),
    dvProfile: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .meta({ description: 'Dolby Vision profile, only when the release states it.' }),
    codec: z.enum(VIDEO_CODECS).optional(),
    bitDepth: z.number().int().min(8).max(16).optional().meta({
      description: 'Stated, or 10 when the release is HDR.',
    }),
    audio: z.string().optional().meta({
      description: 'Main audio codec: truehd, dts-hd, dts, eac3, ac3, aac, opus, flac, mp3.',
      example: 'eac3',
    }),
    container: z.string().optional().meta({
      description: 'File extension, lowercase: mkv, mp4, ts, m2ts, avi, …',
      example: 'mkv',
    }),
    source: z.enum(RELEASE_SOURCES).optional(),
    languages: z
      .array(z.string())
      .optional()
      .meta({
        description: 'Audio languages as ISO 639-2/B codes; `mul` for multi/dual audio.',
        example: ['eng', 'ita'],
      }),
    sizeBytes: z.number().int().nonnegative().optional(),
    durationSec: z.number().int().positive().optional(),
    seeders: z.number().int().nonnegative().optional(),
    cached: z.boolean().optional().meta({
      description:
        'Debrid cache state when the addon says: true is instant, false needs a debrid download.',
    }),
  })
  .meta({ id: 'ParsedSource' });
export type ParsedSource = z.infer<typeof ParsedSourceSchema>;

/** One rule's move of a candidate's score (`explain=true`). */
export const ScoreContributionSchema = z
  .object({
    rule: z.string().meta({
      description:
        'Stable rule id: `tier`, `uncached`, `hdr`, `decodeCost`, `container`, `size`, `language`, `languageSecondary`, `binge`, `lastSource`, `resolution`, `preparedOnly`, `release`, `titleMismatch`, `episodeMismatch`, ...',
      example: 'decodeCost',
    }),
    points: z
      .number()
      .meta({ description: 'Signed: negative lowered the score. Zero moves are left out.' }),
    detail: z.string().optional().meta({
      description: 'Short non-secret note (parsed values only, never stream fields or URLs).',
      example: 'hevc',
    }),
  })
  .meta({ id: 'ScoreContribution' });
export type ScoreContribution = z.infer<typeof ScoreContributionSchema>;

/** Why a candidate scored and played as it did; present only with `explain=true`. */
export const SourceExplainSchema = z
  .object({
    contributions: z.array(ScoreContributionSchema).meta({
      description: 'In the order applied. Their points sum exactly to `score`.',
    }),
    weights: z.record(z.string(), z.number()).meta({
      description:
        'The ranking settings behind the rules that applied, by name (`tiers.http`, `binge.matchBonus`, ...).',
      example: { 'tiers.http': 2000 },
    }),
    playability: z
      .object({
        playable: z.boolean(),
        unplayableReason: z.enum(UNPLAYABLE_REASONS).optional(),
        playableWhen: z.enum(PLAYABLE_WHEN).optional(),
      })
      .meta({ description: 'The playability verdict (rule 1) that goes with the score.' }),
    flags: z
      .array(
        z.object({
          flag: z.enum(ITEM_FLAGS),
          rule: z.enum(['safety.titlePatterns', 'safety.idPrefixes']),
          detail: z.string().optional().meta({
            description:
              'What matched: the pattern, and whether it was the source or its item. Never stream fields or URLs.',
            example: "source name: 'delete all'",
          }),
        }),
      )
      .optional()
      .meta({
        description:
          'Why the candidate carries `flags` (the setting that matched). Flags never change the score; they keep the candidate out of auto-select.',
      }),
  })
  .meta({ id: 'SourceExplain' });
export type SourceExplain = z.infer<typeof SourceExplainSchema>;

export const SourceCandidateSchema = z
  .object({
    key: z.string().meta({
      description:
        'Stable id for this stream within Multitap (a hash of the addon id and the source fields). Pass it back to play the stream.',
    }),
    addonId: z.string(),
    addonName: z.string(),
    kind: z.enum(SOURCE_KINDS),
    name: z.string().meta({ description: "The stream's short label, as the addon gave it." }),
    title: z.string().meta({ description: "The stream's description, as the addon gave it." }),
    parsed: ParsedSourceSchema,
    requiresEngine: z
      .string()
      .optional()
      .meta({ description: 'Only this engine can play it (engine-local content).' }),
    score: z.number().meta({
      description: 'Rank for the target engine; higher is better.',
    }),
    playable: z.boolean(),
    unplayableReason: z.enum(UNPLAYABLE_REASONS).optional(),
    playableWhen: z
      .enum(PLAYABLE_WHEN)
      .optional()
      .meta({ description: '`prepared`: needs a full or scheduled preparation first.' }),
    bingeGroup: z.string().optional().meta({
      description:
        "The addon's `behaviorHints.bingeGroup`: streams of one release share it across episodes. Pass a session's `bingeGroup` back as `preferBingeGroup` to keep the release for the next episode.",
      example: 'torrentio|1080p|WEB-DL',
    }),
    lastUsed: z.literal(true).optional().meta({
      description:
        "Present (true) when the list was asked for a profile (`profileId`) and this is the source the profile last played for this video (its `key` equals the profile's `lastSource.sourceIdentity`). Ranked up by `lastSource.matchBonus`.",
    }),
    flags: ItemFlagsSchema.optional(),
    explain: SourceExplainSchema.optional().meta({
      description: 'The rules behind `score` and `playable`. Only with `explain=true`.',
    }),
  })
  .meta({ id: 'SourceCandidate' });
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
