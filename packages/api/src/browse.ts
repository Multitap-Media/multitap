/**
 * Schemas for Multitap's browse routes (`/v1/catalogs`, `/v1/catalog`, `/v1/meta`,
 * `/v1/streams`, `/v1/subtitles`; okf:architecture/normalized-addon-types, okf:architecture/core-v1-api).
 *
 * These are the normalized forms clients see. Raw addon responses (streams,
 * subtitle URLs) stay in Multitap (okf:architecture/secrets-policy). Plain zod without transforms, so every
 * schema maps one-to-one onto JSON Schema.
 */
import { z } from 'zod';
import { AddonCatalogExtraSchema } from './addons.ts';
import { HIGH_RES_POLICIES, ItemFlagsSchema, SourceCandidateSchema } from './selection.ts';

// ---- Per-addon status --------------------------------------------------------

/** How one addon's part of a request went. */
export const ADDON_CALL_STATUSES = [
  'ok',
  'timeout',
  'error',
  'circuit-open',
  'needs-configuration',
] as const;
export type AddonCallStatusValue = (typeof ADDON_CALL_STATUSES)[number];

export const AddonStatusSchema = z
  .object({
    addonId: z.string().meta({ example: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
    addonName: z.string().meta({ example: 'Torrentio' }),
    status: z.enum(ADDON_CALL_STATUSES).meta({
      description:
        '`ok`: answered. `timeout`: no answer in time. `error`: failed or answered with something invalid. ' +
        '`circuit-open`: not asked, because it has been failing. ' +
        '`needs-configuration`: not asked, because its manifest says it must be configured first.',
    }),
    errorCode: z.string().optional().meta({
      description:
        'Why a non-`ok` addon failed: `timeout`, `network`, `http-status`, `invalid-json`, `validation`, `unexpected-response`, …',
      example: 'http-status',
    }),
    count: z.number().int().min(0).meta({ description: 'Items this addon contributed.' }),
    dropped: z.number().int().min(0).meta({
      description:
        'Items the addon sent that were invalid (or unplayable in any way) and left out.',
    }),
  })
  .meta({ id: 'AddonStatus' });
export type AddonStatus = z.infer<typeof AddonStatusSchema>;

// ---- Catalogs ------------------------------------------------------------------

export const CatalogRefSchema = z
  .object({
    addonId: z.string(),
    addonName: z.string().meta({ example: 'Cinemeta' }),
    type: z.string().meta({ example: 'movie' }),
    id: z.string().meta({ example: 'top' }),
    name: z.string().nullable().meta({ example: 'Popular' }),
    extra: z.array(AddonCatalogExtraSchema).meta({
      description:
        'Extra properties the catalog accepts, as query parameters of `GET /v1/catalog/…`. ' +
        'A required one must always be given.',
    }),
  })
  .meta({ id: 'CatalogRef' });
export type CatalogRef = z.infer<typeof CatalogRefSchema>;

export const POSTER_SHAPES = ['poster', 'square', 'landscape'] as const;

const metaPreviewFields = {
  id: z.string().meta({ example: 'tt1375666' }),
  type: z.string().meta({ example: 'movie' }),
  name: z.string().meta({ example: 'Inception' }),
  poster: z.string().optional().meta({ description: 'Image URL.' }),
  background: z.string().optional().meta({ description: 'Image URL.' }),
  logo: z.string().optional().meta({ description: 'Image URL.' }),
  posterShape: z.enum(POSTER_SHAPES),
  description: z.string().optional(),
  releaseInfo: z.string().optional().meta({ example: '2010' }),
  released: z.iso.datetime().optional().meta({ example: '2010-07-16T00:00:00.000Z' }),
  runtime: z.string().optional().meta({ example: '148 min' }),
  imdbRating: z.string().optional().meta({ example: '8.8' }),
  genres: z.array(z.string()),
  flags: ItemFlagsSchema.optional(),
};

export const MetaPreviewSchema = z.object(metaPreviewFields).meta({ id: 'MetaPreview' });
export type MetaPreview = z.infer<typeof MetaPreviewSchema>;

export const CatalogPageSchema = z
  .object({
    metas: z.array(MetaPreviewSchema).meta({ description: "In the addon's order." }),
    addon: AddonStatusSchema,
  })
  .meta({ id: 'CatalogPage' });
export type CatalogPage = z.infer<typeof CatalogPageSchema>;

// ---- Search ---------------------------------------------------------------------

export const SearchSourceSchema = z
  .object({
    addonId: z.string(),
    addonName: z.string().meta({ example: 'Cinemeta' }),
    catalogId: z.string().meta({ example: 'top' }),
    catalogName: z.string().nullable().meta({ example: 'Popular' }),
    type: z.string().meta({ example: 'movie' }),
    skip: z.number().int().min(0).meta({
      description:
        'The `skip` this catalog was asked with. For its next page ask again with `skip` plus `metas.length`.',
    }),
    metas: z.array(MetaPreviewSchema).meta({ description: "In the addon's order." }),
    addon: AddonStatusSchema,
  })
  .meta({ id: 'SearchSource' });
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchResultSchema = z
  .object({
    query: z.string().meta({ example: 'dune' }),
    skip: z.number().int().min(0),
    sources: z.array(SearchSourceSchema).meta({
      description:
        'One entry per searched catalog, in collection order (each addon in its manifest order). ' +
        'A catalog that failed is listed with its status and no results.',
    }),
  })
  .meta({
    id: 'SearchResult',
    example: {
      query: 'dune',
      skip: 0,
      sources: [
        {
          addonId: '0f8fad5b-d9cb-469f-a165-70867728950e',
          addonName: 'Cinemeta',
          catalogId: 'top',
          catalogName: 'Popular',
          type: 'movie',
          skip: 0,
          metas: [
            {
              id: 'tt1160419',
              type: 'movie',
              name: 'Dune',
              posterShape: 'poster',
              releaseInfo: '2021',
              genres: ['Adventure', 'Drama', 'Sci-Fi'],
            },
          ],
          addon: {
            addonId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            addonName: 'Cinemeta',
            status: 'ok',
            count: 1,
            dropped: 0,
          },
        },
        {
          addonId: '5d1c8d3e-6a77-4b0c-9f0e-2b6f0c1a7e11',
          addonName: 'Another addon',
          catalogId: 'search',
          catalogName: 'Search',
          type: 'series',
          skip: 0,
          metas: [],
          addon: {
            addonId: '5d1c8d3e-6a77-4b0c-9f0e-2b6f0c1a7e11',
            addonName: 'Another addon',
            status: 'timeout',
            errorCode: 'timeout',
            count: 0,
            dropped: 0,
          },
        },
      ],
    },
  });
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---- Meta ------------------------------------------------------------------------

export const MetaLinkSchema = z
  .object({
    name: z.string().meta({ example: 'Christopher Nolan' }),
    category: z.string().meta({ example: 'Directors' }),
    url: z.string().meta({ description: 'Often a `stremio:///…` deep link.' }),
  })
  .meta({ id: 'MetaLink' });
export type MetaLink = z.infer<typeof MetaLinkSchema>;

export const MetaTrailerSchema = z
  .object({
    ytId: z.string().meta({ description: 'YouTube video id.', example: 'YoHD9XEInc0' }),
    title: z.string().optional(),
  })
  .meta({ id: 'MetaTrailer' });
export type MetaTrailer = z.infer<typeof MetaTrailerSchema>;

export const MetaVideoSchema = z
  .object({
    id: z.string().meta({
      description: 'The video id to ask `/v1/streams` for (`tt0903747:1:1` for an episode).',
      example: 'tt0903747:1:1',
    }),
    title: z.string(),
    released: z.iso.datetime().optional(),
    overview: z.string().optional(),
    thumbnail: z.string().optional().meta({ description: 'Image URL.' }),
    season: z.number().int().min(0).optional(),
    episode: z.number().int().min(0).optional(),
  })
  .meta({ id: 'MetaVideo' });
export type MetaVideo = z.infer<typeof MetaVideoSchema>;

export const MetaBehaviorHintsSchema = z
  .object({
    isLive: z.boolean(),
    defaultVideoId: z.string().optional(),
    featuredVideoId: z.string().optional(),
    hasScheduledVideos: z.boolean(),
  })
  .meta({ id: 'MetaBehaviorHints' });

export const MetaDetailSchema = z
  .object({
    ...metaPreviewFields,
    links: z.array(MetaLinkSchema),
    trailers: z.array(MetaTrailerSchema),
    videos: z.array(MetaVideoSchema).meta({
      description: 'Episodes (by season, then episode; specials last) or other videos.',
    }),
    behaviorHints: MetaBehaviorHintsSchema,
  })
  .meta({ id: 'MetaDetail' });
export type MetaDetail = z.infer<typeof MetaDetailSchema>;

export const MetaResultSchema = z
  .object({
    meta: MetaDetailSchema,
    addonId: z.string().meta({ description: 'The addon the meta came from.' }),
    addons: z.array(AddonStatusSchema).meta({
      description: 'Every addon that was asked, in collection order.',
    }),
  })
  .meta({ id: 'MetaResult' });
export type MetaResult = z.infer<typeof MetaResultSchema>;

// ---- Streams ----------------------------------------------------------------------

export const SOURCE_ORDERS = ['addon', 'rank'] as const;
export type SourceOrder = (typeof SOURCE_ORDERS)[number];

export const SourceListSchema = z
  .object({
    engine: z.string().meta({ description: 'The engine candidates were ranked for.' }),
    highRes: z.enum(HIGH_RES_POLICIES),
    sort: z.enum(SOURCE_ORDERS),
    candidates: z.array(SourceCandidateSchema).meta({
      description:
        '`sort=addon`: grouped in collection order, each addon in its own order. `sort=rank`: playable first, then by score. Nothing is hidden.',
    }),
    addons: z.array(AddonStatusSchema).meta({
      description: 'Every addon that was asked, in collection order.',
    }),
  })
  .meta({ id: 'SourceList' });
export type SourceList = z.infer<typeof SourceListSchema>;

/** The `202` answer of `GET /v1/streams/…?incremental=true` (okf:concept/addon-aggregation): results follow as events. */
export const SourceListStartedSchema = z
  .object({
    requestId: z.string().meta({
      description:
        "Identifies this list's `streams.partial` events; follow them with `GET /v1/events?request={requestId}`, which replays the ones already sent.",
      example: 'rq_3q2x7wAbCdEfGhIjKlMnOp',
    }),
    engine: z.string().meta({ description: 'The engine candidates are ranked for.' }),
    highRes: z.enum(HIGH_RES_POLICIES),
    addons: z.number().int().min(0).meta({
      description:
        'Addons asked: one `streams.partial` event each, the last with `remaining: 0`. 0 = no events.',
    }),
  })
  .meta({ id: 'SourceListStarted' });
export type SourceListStarted = z.infer<typeof SourceListStartedSchema>;

// ---- Subtitles --------------------------------------------------------------------

export const SubtitleTrackSchema = z
  .object({
    id: z.string().meta({ description: "Multitap's id for the file; stable while it's cached." }),
    lang: z
      .string()
      .meta({ description: 'As the addon gave it, usually ISO 639-2.', example: 'eng' }),
    label: z.string().optional(),
    addonId: z.string(),
    url: z.string().meta({
      description:
        'Multitap path serving the file as WebVTT. Needs an API key, like any /v1 route.',
      example: '/v1/subtitles/file/3q2-7wAbCdEfGhIjKlMnOpQrStUvWxYz.vtt',
    }),
  })
  .meta({ id: 'SubtitleTrack' });
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;

export const SubtitleListSchema = z
  .object({
    subtitles: z.array(SubtitleTrackSchema).meta({ description: 'In collection order.' }),
    addons: z.array(AddonStatusSchema).meta({
      description: 'Every addon that was asked, in collection order.',
    }),
  })
  .meta({ id: 'SubtitleList' });
export type SubtitleList = z.infer<typeof SubtitleListSchema>;
