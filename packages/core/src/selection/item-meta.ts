/**
 * `selection/item-meta`: what ranking needs from an item's meta (see
 * okf:concept/source-ranking): its name for title matching (rule 7), the requested episode's season
 * and number, and the runtime for the size check (rule 6).
 *
 * Fetched through the addon layer (`aggregate('meta')`, the first addon in
 * collection order that has one, as in Stremio, with the addon response
 * cache), and kept here for a while too, so a source list and a later
 * auto-select don't ask again. A failed lookup is cached briefly and ranking
 * goes on without it: no mismatch scoring, no runtime.
 */
import type { MetaItem, Stream } from '@multitap/addon-protocol';
import type { AddonService, AggregateResult } from '../addons/index.ts';
import type { Clock } from '../auth/keys.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { MatchTarget } from './match.ts';

export interface ItemInfo {
  /** For {@link RankOptions.target}. */
  target: MatchTarget;
  /** The item's (or episode's) runtime, when the meta states one. */
  runtimeSec?: number | undefined;
  /**
   * Streams the meta itself carries for this video (`videos[].streams`, or a
   * movie's own `streams`), attributed to the addon that served the meta.
   * Never `trailerStreams`: trailers aren't sources (as in stremio-core).
   */
  embedded?: { addonId: string; addonName: string; streams: Stream[] } | undefined;
}

export interface ItemMetaLookupOptions {
  addons: Pick<AddonService, 'aggregate'>;
  clock: Clock;
  /** Default 1 h. */
  ttlMs?: number;
  /** How long a failed lookup is remembered. Default 1 min. */
  failureTtlMs?: number;
  /** Default 500. */
  maxEntries?: number;
}

/**
 * `148 min`, `2h 28min`, `1h`, `45`, `PT1H2M` → seconds. Anything else is
 * undefined: runtimes are free text in the protocol.
 */
export function parseRuntime(runtime: string | undefined): number | undefined {
  if (runtime === undefined) return undefined;
  const text = runtime.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 60) || undefined;
  // `(?<!\d)`: a match starts where a number does, so a run of digits is scanned once.
  const h = /(?<!\d)(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\b|(?<!\d)(\d+)h/.exec(text);
  const m = /(?<!\d)(\d+)\s*m(?:in(?:utes?|s)?)?\b|(?<!\d)(\d+)m/.exec(text);
  const hours = Number(h?.[1] ?? h?.[2] ?? 0);
  const minutes = Number(m?.[1] ?? m?.[2] ?? 0);
  const seconds = Math.round(hours * 3600 + minutes * 60);
  return seconds > 0 ? seconds : undefined;
}

/**
 * The meta id and requested episode for a video id: `tt0903747:1:2` → the
 * series `tt0903747`, S1E2 (the meta's `videos` win when they list the id).
 * Movies and other types use the id as it is.
 */
export function splitVideoId(
  type: string,
  videoId: string,
): { itemId: string; season?: number; episode?: number } {
  // A channel video (`yt_id:{channel}:{video}`) belongs to the meta of its channel.
  const channelVideo = /^(yt_id:[^:]+):[^:]+$/.exec(videoId)?.[1];
  if (channelVideo !== undefined) return { itemId: channelVideo };
  if (type !== 'series' && type !== 'anime') return { itemId: videoId };
  const se = /^(.+):(\d+):(\d+)$/.exec(videoId);
  // The meta id has digits (`tt0903747`); `kitsu:1376:5` is the meta id `kitsu:1376` and an episode.
  if (se?.[1] !== undefined && /\d/.test(se[1])) {
    return { itemId: se[1], season: Number(se[2]), episode: Number(se[3]) };
  }
  // `kitsu:123:5`-style ids carry an absolute episode only.
  const prefix = /^(.+):(\d+)$/.exec(videoId)?.[1];
  if (prefix?.includes(':')) return { itemId: prefix };
  return { itemId: videoId };
}

/** What ranking takes from a meta, for one video. */
export function itemInfo(
  meta: MetaItem,
  videoId: string,
  fromId: { season?: number; episode?: number } = {},
): ItemInfo {
  const { season, episode } = fromId;
  const video = meta.videos.find((v) => v.id === videoId);
  const target: MatchTarget = { name: meta.name };
  // `2010`, `2008–2013`: the first year.
  const year = /(?:19|20)\d{2}/.exec(meta.releaseInfo ?? '')?.[0];
  if (year !== undefined) target.year = Number(year);
  const s = video?.season ?? season;
  const e = video?.episode ?? episode;
  if (s !== undefined && e !== undefined) {
    target.season = s;
    target.episode = e;
  }
  const videoRuntime = (video as { runtime?: unknown } | undefined)?.runtime;
  const runtimeSec =
    parseRuntime(typeof videoRuntime === 'string' ? videoRuntime : undefined) ??
    parseRuntime(meta.runtime);
  return { target, runtimeSec };
}

/**
 * The streams a meta carries for one video: the video's own `streams`, or, for
 * a movie (the video is the item), the meta's.
 */
export function embeddedStreams(meta: MetaItem, videoId: string): Stream[] {
  const video = meta.videos.find((v) => v.id === videoId);
  if (video !== undefined && video.streams.length > 0) return video.streams;
  return videoId === meta.id ? meta.streams : [];
}

export class ItemMetaLookup {
  readonly #addons: Pick<AddonService, 'aggregate'>;
  readonly #cache: TtlCache<ItemInfo | null>;
  readonly #failures: TtlCache<null>;
  readonly #inflight = new Map<string, Promise<ItemInfo | undefined>>();

  constructor(options: ItemMetaLookupOptions) {
    this.#addons = options.addons;
    const maxEntries = options.maxEntries ?? 500;
    this.#cache = new TtlCache({
      clock: options.clock,
      ttlMs: options.ttlMs ?? 3_600_000,
      maxEntries,
    });
    this.#failures = new TtlCache({
      clock: options.clock,
      ttlMs: options.failureTtlMs ?? 60_000,
      maxEntries,
    });
  }

  /** The item's info for `videoId`, or undefined when no addon has a meta for it (or every one failed). */
  async lookup(type: string, videoId: string): Promise<ItemInfo | undefined> {
    const key = `${type}\u0000${videoId}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    if (this.#failures.get(key) !== undefined) return undefined;
    let pending = this.#inflight.get(key);
    if (pending === undefined) {
      pending = this.#fetch(type, videoId, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async #fetch(type: string, videoId: string, key: string): Promise<ItemInfo | undefined> {
    const split = splitVideoId(type, videoId);
    let result: AggregateResult<'meta'>;
    try {
      result = await this.#addons.aggregate('meta', type, split.itemId);
    } catch {
      this.#failures.set(key, null);
      return undefined;
    }
    const owner = result.addons.find((o) => o.status === 'ok' && o.items[0]);
    const meta = owner?.items[0];
    if (owner === undefined || meta === undefined) {
      // Addons that answered without a meta are a real answer; failures may pass.
      if (result.addons.some((o) => o.status !== 'ok')) this.#failures.set(key, null);
      else this.#cache.set(key, null);
      return undefined;
    }
    const info = itemInfo(meta, videoId, split);
    const streams = embeddedStreams(meta, videoId);
    if (streams.length > 0) {
      info.embedded = { addonId: owner.addonId, addonName: owner.addonName, streams };
    }
    this.#cache.set(key, info);
    return info;
  }
}
