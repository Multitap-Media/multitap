/**
 * Meta items. Ported from stremio-core's `types/resource/meta_item.rs`.
 */
import { z } from 'zod';
import {
  defaultOnNull,
  lenientUrl,
  millisToDateTime,
  numberAsString,
  optional,
  parseDateTime,
  u32,
  urlString,
} from './common.ts';
import { StreamSchema, streamSourceVariant, youtubeStream, type Stream } from './stream.ts';

export const LinkSchema = z.looseObject({
  name: z.string(),
  category: z.string(),
  url: urlString,
});
export type Link = z.output<typeof LinkSchema>;

/** A legacy trailer: `{ source: <YouTube id>, type: 'Trailer' | 'Clip' | … }`. */
export const TrailerSchema = z.looseObject({ source: z.string(), type: z.string() });
export type Trailer = z.output<typeof TrailerSchema>;

/** `PickFirst<(Trailer, Stream)>`: a trailer object, or a YouTube stream read as a trailer. */
const trailerOrYouTubeStream = z.union([
  TrailerSchema,
  StreamSchema.transform((stream, ctx): Trailer => {
    if (streamSourceVariant(stream) === 'youTube' && typeof stream.ytId === 'string') {
      return { source: stream.ytId, type: 'Trailer' };
    }
    ctx.addIssue({ code: 'custom', message: 'Unsupported Trailer StreamSource' });
    return z.NEVER;
  }),
]);

export const POSTER_SHAPES = ['poster', 'square', 'landscape'] as const;
export type PosterShape = (typeof POSTER_SHAPES)[number];

/** `DefaultOnNull<PosterShape>` with `#[serde(other)]`: unknown strings become `poster`. */
const posterShape = z
  .string()
  .nullish()
  .transform((value): PosterShape =>
    value === 'square' || value === 'landscape' ? value : 'poster',
  );

/**
 * `released` on a meta item: an RFC 3339 string or epoch milliseconds. Normalized
 * to an ISO 8601 UTC string; anything unparsable becomes `undefined`.
 */
const previewReleased = z
  .unknown()
  .optional()
  .transform((value): string | undefined =>
    typeof value === 'string'
      ? parseDateTime(value)
      : typeof value === 'number'
        ? millisToDateTime(value)
        : undefined,
  );

/** `released` on a video: an RFC 3339 string, normalized; anything else becomes `undefined`. */
const videoReleased = z
  .unknown()
  .optional()
  .transform((value): string | undefined =>
    typeof value === 'string' ? parseDateTime(value) : undefined,
  );

export const MetaItemBehaviorHintsSchema = z.looseObject({
  isLive: z.boolean().default(false),
  defaultVideoId: optional(z.string()),
  featuredVideoId: optional(z.string()),
  hasScheduledVideos: z.boolean().default(false),
});
export type MetaItemBehaviorHints = z.output<typeof MetaItemBehaviorHintsSchema>;

/** A season/episode number; flattened `Option<SeriesInfo>` never fails the video. */
const lenientU32 = z
  .unknown()
  .optional()
  .transform((value): number | undefined =>
    u32.safeParse(value).success ? (value as number) : undefined,
  );

export const VideoSchema = z
  .looseObject({
    id: z.string(),
    /** `name` is accepted as an alias; on output `title` falls back to it, then to `''`. */
    title: z.string().optional(),
    name: z.unknown().optional(),
    released: videoReleased,
    overview: optional(z.string()),
    thumbnail: optional(z.string()),
    /** One stream or a list; `stream` is accepted as an alias. */
    streams: z.union([z.array(StreamSchema), StreamSchema]).optional(),
    stream: z.unknown().optional(),
    season: lenientU32,
    episode: lenientU32,
    trailerStreams: z.array(StreamSchema).default(() => []),
  })
  .transform((video, ctx) => {
    let title = video.title;
    if (title === undefined && video.name !== undefined) {
      const name = z.string().safeParse(video.name);
      if (!name.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid video name', path: ['name'] });
        return z.NEVER;
      }
      title = name.data;
    }
    let streams = video.streams;
    if (streams === undefined && video.stream !== undefined) {
      const stream = z.union([z.array(StreamSchema), StreamSchema]).safeParse(video.stream);
      if (!stream.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid video stream', path: ['stream'] });
        return z.NEVER;
      }
      streams = stream.data;
    }
    return {
      ...video,
      title: title ?? '',
      streams: streams === undefined ? [] : Array.isArray(streams) ? streams : [streams],
    };
  });
export type Video = z.output<typeof VideoSchema>;

/** True when the video has both a season and an episode (`series_info` is `Some`). */
function hasSeriesInfo(video: Video): video is Video & { season: number; episode: number } {
  return video.season !== undefined && video.episode !== undefined;
}

/** `VideoSortedVecAdapter::cmp`: episodes by season (specials last) then episode, then by date. */
function compareVideos(a: Video, b: Video, isSeries: boolean): number {
  if (hasSeriesInfo(a) && hasSeriesInfo(b)) {
    const aSeason = a.season === 0 ? Number.MAX_SAFE_INTEGER : a.season;
    const bSeason = b.season === 0 ? Number.MAX_SAFE_INTEGER : b.season;
    return aSeason - bSeason || a.episode - b.episode;
  }
  if (hasSeriesInfo(a)) return -1;
  if (hasSeriesInfo(b)) return 1;
  if (a.released !== undefined && b.released !== undefined) {
    const diff = Date.parse(a.released) - Date.parse(b.released);
    return isSeries ? diff : -diff;
  }
  if (a.released !== undefined) return -1;
  if (b.released !== undefined) return 1;
  return 0;
}

/**
 * `DefaultOnNull<SortedVec<UniqueVec<…>>>` for `videos`: deduplicated by id
 * (first wins), then stably sorted. Unlike stremio-core, an invalid video is
 * skipped instead of failing the whole meta item.
 */
const videoList = z
  .array(z.unknown())
  .nullish()
  .transform((items): Video[] => {
    const seen = new Set<string>();
    const videos: Video[] = [];
    for (const item of items ?? []) {
      const result = VideoSchema.safeParse(item);
      if (!result.success || seen.has(result.data.id)) continue;
      seen.add(result.data.id);
      videos.push(result.data);
    }
    const isSeries = videos.some(hasSeriesInfo);
    return videos.sort((a, b) => compareVideos(a, b, isSeries));
  });

const metaItemPreviewShape = {
  id: z.string(),
  type: z.string(),
  name: defaultOnNull(z.string(), () => ''),
  poster: lenientUrl,
  background: lenientUrl,
  logo: lenientUrl,
  description: optional(z.string()),
  releaseInfo: optional(numberAsString),
  runtime: optional(numberAsString),
  released: previewReleased,
  posterShape,
  imdbRating: optional(numberAsString),
  genres: defaultOnNull(z.array(z.string()), () => []),
  links: defaultOnNull(z.array(LinkSchema), () => []),
  trailers: defaultOnNull(z.array(trailerOrYouTubeStream), () => []),
  trailerStreams: optional(z.array(StreamSchema)),
  behaviorHints: z.preprocess((value) => value ?? {}, MetaItemBehaviorHintsSchema),
};

/** `MetaItemPreviewLegacy` → `MetaItemPreview`: `trailerStreams` falls back to the `Trailer` entries of `trailers`. */
function withTrailerStreams<
  T extends { trailers: Trailer[]; trailerStreams: Stream[] | undefined },
>(item: T): T & { trailerStreams: Stream[] } {
  const trailerStreams =
    item.trailerStreams ??
    item.trailers
      .filter((trailer) => trailer.type === 'Trailer')
      .map((trailer) => StreamSchema.parse({ ytId: trailer.source }));
  return { ...item, trailerStreams };
}

/** A catalog entry. */
export const MetaItemPreviewSchema = z
  .looseObject(metaItemPreviewShape)
  .transform(withTrailerStreams);
export type MetaItemPreview = z.output<typeof MetaItemPreviewSchema>;

/**
 * Streams carried by the meta item itself (a movie served with its own
 * streams): one or a list; invalid entries are skipped. Not part of
 * stremio-core's `MetaItem`, which only reads `videos[].streams`.
 */
const embeddedStreams = z
  .unknown()
  .optional()
  .transform((value): Stream[] =>
    (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).flatMap(
      (item) => {
        const result = StreamSchema.safeParse(item);
        return result.success ? [result.data] : [];
      },
    ),
  );

/** A full meta item, with its videos (episodes, channel uploads, …). */
export const MetaItemSchema = z
  .looseObject({ ...metaItemPreviewShape, videos: videoList, streams: embeddedStreams })
  .transform(withTrailerStreams);
export type MetaItem = z.output<typeof MetaItemSchema>;

/**
 * `Video::stream`: the video's only stream; or, when it has none, the YouTube
 * stream derived from a `yt_id:{channel}:{video}` id. `undefined` otherwise
 * (several streams mean the user picks through the stream resource).
 */
export function videoStream(video: Pick<Video, 'id' | 'streams'>): Stream | undefined {
  if (video.streams.length === 1) return video.streams[0];
  if (video.streams.length === 0) return youtubeStream(video.id);
  return undefined;
}
