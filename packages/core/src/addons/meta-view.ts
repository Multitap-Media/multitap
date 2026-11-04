/**
 * API views of addon meta items (`@multitap/api`'s `MetaPreview` and
 * `MetaDetail`, okf:architecture/normalized-addon-types): the fields a client shows, with nothing
 * addon-specific passed through. Embedded streams are left out; trailers are
 * reduced to YouTube ids; deep links that carry an addon URL are dropped.
 * Image URLs must be http(s), links http(s) or `stremio:`; any other scheme
 * (`javascript:`, `data:`, …) is left out.
 * With the `safety` ranking settings, an item that looks like an action
 * (okf:decision/destructive-items-flagged) carries `flags`.
 */
import type { MetaDetail, MetaPreview, MetaTrailer, MetaVideo, RankingSafety } from '@multitap/api';
import { streamSourceVariant, type MetaItem, type MetaItemPreview } from '@multitap/addon-protocol';
import { itemFlags } from '../selection/safety.ts';

/** Only four-digit-year ISO date-times fit the schema's `date-time` format. */
function isoDate(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-/.test(value) ? value : undefined;
}

/** Copies the keys of `from` whose values are defined. */
function defined<T extends Record<string, unknown>>(
  from: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(from).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * True for a Stremio deep link that carries a URL, such as
 * `stremio:///discover/{transportUrl}/{type}/{catalog}?genre=…` (AIOMetadata's
 * and Cinemeta's genre links). The transport URL is a manifest URL, which can
 * carry an addon's configuration or credentials (okf:architecture/secrets-policy), and a client of Multitap
 * can't follow such a link anyway; links like `stremio:///search?search=…` stay.
 */
export function embedsAddonUrl(url: string): boolean {
  const match = /^\s*stremio:(.*)$/is.exec(url);
  if (match === null) return false;
  // Any `http:`/`https:` in the link, however many times it was encoded:
  // `https:/host` and `https:\\host` reach a host too.
  let text = match[1] ?? '';
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    if (/https?:/i.test(text)) return true;
    // Only ASCII escapes matter here, and decoding just those never fails on a
    // malformed escape elsewhere in the link.
    const decoded = text.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === text) return false;
    text = decoded;
  }
  // Still encoded after that many rounds: nothing a client should follow.
  return true;
}

/** How many layers of percent-encoding {@link embedsAddonUrl} looks through. */
const MAX_DECODE_ROUNDS = 8;

const scheme = (url: string): string | undefined => URL.parse(url.trim())?.protocol;

/**
 * An image URL a client may load: http(s) only, so a `javascript:` or `data:`
 * URL from an addon never reaches it.
 */
export function imageUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const protocol = scheme(url);
  return protocol === 'http:' || protocol === 'https:' ? url : undefined;
}

/** A link a client may follow: http(s), or a Stremio deep link that carries no addon URL. */
export function linkUrl(url: string): string | undefined {
  const protocol = scheme(url);
  if (protocol === 'http:' || protocol === 'https:') return url;
  return protocol === 'stremio:' && !embedsAddonUrl(url) ? url : undefined;
}

export function metaPreviewView(item: MetaItemPreview, safety?: RankingSafety): MetaPreview {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    posterShape: item.posterShape,
    genres: item.genres,
    ...defined({
      poster: imageUrl(item.poster),
      background: imageUrl(item.background),
      logo: imageUrl(item.logo),
      description: item.description,
      releaseInfo: item.releaseInfo,
      released: isoDate(item.released),
      runtime: item.runtime,
      imdbRating: item.imdbRating,
    }),
    ...itemFlags(item, safety),
  };
}

export function metaDetailView(item: MetaItem, safety?: RankingSafety): MetaDetail {
  const trailers: MetaTrailer[] = [];
  for (const stream of item.trailerStreams) {
    if (streamSourceVariant(stream) !== 'youTube' || typeof stream.ytId !== 'string') continue;
    const trailer: MetaTrailer = { ytId: stream.ytId };
    const title = stream.title ?? stream.name;
    if (title !== undefined) trailer.title = title;
    trailers.push(trailer);
  }
  const videos = item.videos.map((video): MetaVideo => ({
    id: video.id,
    title: video.title,
    ...defined({
      released: isoDate(video.released),
      overview: video.overview,
      thumbnail: imageUrl(video.thumbnail),
      season: video.season,
      episode: video.episode,
    }),
  }));
  const hints = item.behaviorHints;
  return {
    ...metaPreviewView(item, safety),
    links: item.links.flatMap((link) => {
      const url = linkUrl(link.url);
      return url === undefined ? [] : [{ name: link.name, category: link.category, url }];
    }),
    trailers,
    videos,
    behaviorHints: {
      isLive: hints.isLive,
      hasScheduledVideos: hints.hasScheduledVideos,
      ...defined({
        defaultVideoId: hints.defaultVideoId,
        featuredVideoId: hints.featuredVideoId,
      }),
    },
  };
}
