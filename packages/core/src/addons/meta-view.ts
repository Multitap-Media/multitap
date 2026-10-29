/**
 * API views of addon meta items (`@multitap/api`'s `MetaPreview` and
 * `MetaDetail`, okf:architecture/normalized-addon-types): the fields a client shows, with nothing
 * addon-specific passed through. Embedded streams are left out; trailers are
 * reduced to YouTube ids; deep links that carry an addon URL are dropped.
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
  const match = /^stremio:\/\/(.*)$/is.exec(url.trim());
  if (match === null) return false;
  const rest = match[1] ?? '';
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A malformed escape: judge the raw text.
  }
  return /https?:\/\//i.test(rest) || /https?:\/\//i.test(decoded);
}

export function metaPreviewView(item: MetaItemPreview, safety?: RankingSafety): MetaPreview {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    posterShape: item.posterShape,
    genres: item.genres,
    ...defined({
      poster: item.poster,
      background: item.background,
      logo: item.logo,
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
      thumbnail: video.thumbnail,
      season: video.season,
      episode: video.episode,
    }),
  }));
  const hints = item.behaviorHints;
  return {
    ...metaPreviewView(item, safety),
    links: item.links
      .filter((link) => !embedsAddonUrl(link.url))
      .map((link) => ({ name: link.name, category: link.category, url: link.url })),
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
