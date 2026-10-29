/**
 * Streams. Ported from stremio-core's `types/resource/stream.rs`.
 *
 * A stream is flat JSON: the common fields (`name`, `description`, …) sit next
 * to the fields of its source (`url`, `infoHash`, `ytId`, …). stremio-core reads
 * the source as an *untagged* enum, trying each variant in declaration order
 * and taking the first that deserializes. `STREAM_SOURCE_VARIANTS` keeps that
 * order, and the stream schema walks it the same way, so an object with both a
 * valid `url` and an `infoHash` is a `url` stream, while one with an unparsable
 * `url` and a valid `infoHash` is a `torrent` stream.
 */
import { z } from 'zod';
import { defaultOnNull, optional, u16, u64, urlString } from './common.ts';
import { SubtitlesSchema, type Subtitles } from './subtitles.ts';

const stringList = defaultOnNull(z.array(z.string()), () => []);

/**
 * The most characters kept of a stream's text fields (`name`, `description`,
 * `title`, `behaviorHints.filename` and `bingeGroup`). Multitap parses them with
 * regexes and a third-party release-name parser on every source listing, so a
 * hostile addon's megabyte-long description must not reach them whole
 * (okf:concept/addon-aggregation). Real labels are a few hundred characters;
 * longer text is cut, not refused, so the stream stays usable.
 */
export const STREAM_TEXT_MAX_CHARS = 4096;

const streamText = z
  .string()
  .transform((value) =>
    value.length > STREAM_TEXT_MAX_CHARS ? value.slice(0, STREAM_TEXT_MAX_CHARS) : value,
  );

/** `ArchiveUrl`: `[url]` or `[url, sizeInBytes]`. */
export const ArchiveUrlSchema = z.tuple([urlString, u64.nullish()]);
export type ArchiveUrl = z.output<typeof ArchiveUrlSchema>;

function archiveSource<K extends string>(key: K) {
  return z.looseObject({
    ...({ [key]: z.array(ArchiveUrlSchema) } as Record<K, z.ZodArray<typeof ArchiveUrlSchema>>),
    fileIdx: optional(u16),
    fileMustInclude: stringList,
  });
}

export const UrlSourceSchema = z.looseObject({ url: urlString });
export const YouTubeSourceSchema = z.looseObject({ ytId: z.string() });
export const RarSourceSchema = archiveSource('rarUrls');
export const ZipSourceSchema = archiveSource('zipUrls');
export const Zip7SourceSchema = archiveSource('7zipUrls');
export const TgzSourceSchema = archiveSource('tgzUrls');
export const TarSourceSchema = archiveSource('tarUrls');
export const NzbSourceSchema = z.looseObject({
  nzbUrl: optional(urlString),
  nzbUrls: defaultOnNull(z.array(urlString), () => []),
  servers: z.array(urlString),
});
export const TorrentSourceSchema = z
  .looseObject({
    /** 40 hex digits (`SerHex<Strict>`), lowercased on output. */
    infoHash: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/, 'Invalid info hash')
      .transform((value) => value.toLowerCase()),
    fileIdx: optional(u16),
    /** Trackers and DHT sources; `sources` is accepted as an alias. */
    announce: z.array(z.string()).nullish(),
    sources: z.array(z.string()).nullish(),
    fileMustInclude: stringList,
  })
  .transform((source) => ({ ...source, announce: source.announce ?? source.sources ?? [] }));
export const PlayerFrameSourceSchema = z.looseObject({ playerFrameUrl: urlString });
export const ExternalSourceSchema = z
  .looseObject({
    externalUrl: optional(urlString),
    androidTvUrl: optional(urlString),
    tizenUrl: optional(z.string()),
    webosUrl: optional(z.string()),
  })
  .refine(
    (source) =>
      source.externalUrl !== undefined ||
      source.androidTvUrl !== undefined ||
      source.tizenUrl !== undefined ||
      source.webosUrl !== undefined,
    { message: 'Invalid StreamSource::External' },
  );

/** stremio-core's `StreamSource` variants, in its deserialization order. */
export const STREAM_SOURCE_VARIANTS = [
  ['url', UrlSourceSchema],
  ['youTube', YouTubeSourceSchema],
  ['rar', RarSourceSchema],
  ['zip', ZipSourceSchema],
  ['zip7', Zip7SourceSchema],
  ['tgz', TgzSourceSchema],
  ['tar', TarSourceSchema],
  ['nzb', NzbSourceSchema],
  ['torrent', TorrentSourceSchema],
  ['playerFrame', PlayerFrameSourceSchema],
  ['external', ExternalSourceSchema],
] as const;

export type StreamSourceVariant = (typeof STREAM_SOURCE_VARIANTS)[number][0];

/** Any stream source. `z.union` returns the first option that parses, so the order holds. */
export const StreamSourceSchema = z.union(STREAM_SOURCE_VARIANTS.map(([, schema]) => schema));
export type StreamSource = z.output<typeof StreamSourceSchema>;

export const StreamProxyHeadersSchema = z.looseObject({
  request: z.record(z.string(), z.string()).default(() => ({})),
  response: z.record(z.string(), z.string()).default(() => ({})),
});
export type StreamProxyHeaders = z.output<typeof StreamProxyHeadersSchema>;

export const StreamBehaviorHintsSchema = z.looseObject({
  notWebReady: z.boolean().default(false),
  bingeGroup: optional(streamText),
  countryWhitelist: optional(z.array(z.string())),
  proxyHeaders: optional(StreamProxyHeadersSchema),
  filename: optional(streamText),
  videoHash: optional(z.string()),
  videoSize: optional(u64),
});
export type StreamBehaviorHints = z.output<typeof StreamBehaviorHintsSchema>;

/** `DefaultOnNull<VecSkipError<Subtitles>>`: invalid subtitle entries are skipped. */
const subtitlesSkipInvalid = z
  .array(z.unknown())
  .nullish()
  .transform((items): Subtitles[] =>
    (items ?? []).flatMap((item) => {
      const result = SubtitlesSchema.safeParse(item);
      return result.success ? [result.data] : [];
    }),
  );

const StreamBaseSchema = z.looseObject({
  name: optional(streamText),
  /** `title` is the legacy name; on output `description` falls back to it. */
  description: optional(streamText),
  title: optional(streamText),
  thumbnail: optional(z.string()),
  subtitles: subtitlesSkipInvalid,
  behaviorHints: z.preprocess((value) => value ?? {}, StreamBehaviorHintsSchema),
});
type StreamBase = z.output<typeof StreamBaseSchema>;

export type Stream = StreamBase & StreamSource;

export const StreamSchema = StreamBaseSchema.transform((base, ctx): Stream => {
  const withDescription = { ...base, description: base.description ?? base.title };
  for (const [, schema] of STREAM_SOURCE_VARIANTS) {
    const source = schema.safeParse(withDescription);
    if (source.success) return { ...withDescription, ...source.data };
  }
  ctx.addIssue({ code: 'custom', message: 'Expected a valid StreamSource' });
  return z.NEVER;
});

/**
 * Which `StreamSource` variant a stream (parsed or raw) deserializes as, using
 * stremio-core's precedence. `undefined` if none.
 */
export function streamSourceVariant(stream: unknown): StreamSourceVariant | undefined {
  for (const [variant, schema] of STREAM_SOURCE_VARIANTS) {
    if (schema.safeParse(stream).success) return variant;
  }
  return undefined;
}

export type StreamSourceKind =
  'url' | 'youtube' | 'torrent' | 'archive' | 'nzb' | 'playerFrame' | 'external';

const KIND_BY_VARIANT: Record<StreamSourceVariant, StreamSourceKind> = {
  url: 'url',
  youTube: 'youtube',
  rar: 'archive',
  zip: 'archive',
  zip7: 'archive',
  tgz: 'archive',
  tar: 'archive',
  nzb: 'nzb',
  torrent: 'torrent',
  playerFrame: 'playerFrame',
  external: 'external',
};

/** A coarse classification of a stream's source. `undefined` if it has no valid source. */
export function streamSourceKind(stream: unknown): StreamSourceKind | undefined {
  const variant = streamSourceVariant(stream);
  return variant === undefined ? undefined : KIND_BY_VARIANT[variant];
}

/** stremio-core's `YOUTUBE_ADDON_ID_PREFIX`. */
export const YOUTUBE_ID_PREFIX = 'yt_id:';

/**
 * `Stream::youtube`: the stream for a YouTube addon video id
 * (`yt_id:{channel}:{video}`), or `undefined` for any other id.
 */
export function youtubeStream(videoId: string): Stream | undefined {
  if (!videoId.startsWith(YOUTUBE_ID_PREFIX)) return undefined;
  const ytId = videoId.split(':')[2];
  return ytId === undefined ? undefined : StreamSchema.parse({ ytId });
}
