/**
 * `selection/source-list`: the standard source list (okf:concept/source-ranking). Asks
 * every matching addon for streams, turns them into candidates annotated for
 * one engine, and keeps each raw stream in the {@link StreamStore}.
 *
 * Streams embedded in a meta (`videos[].streams`, or a movie's own) are
 * candidates of the addon that served the meta, merged with the stream addons'
 * and keyed the same way; trailers are not sources.
 *
 * Like Stremio, a YouTube addon video id (`yt_id:{channel}:{video}`) also
 * gets the stream derived from the id itself (stremio-core `Stream::youtube`,
 * used by `Video::stream`), attributed to the addon that serves meta for it:
 * the YouTube channels addon declares only `catalog` and `meta`.
 *
 * The item's meta (name, episode, runtime) is looked up alongside, for
 * mismatch scoring and the size check (okf:concept/source-ranking rules 6–7), and for the safety
 * flags: an item whose id or name matches `settings.safety` flags every
 * candidate, and a flagged candidate's stored stream remembers it, so a
 * session that plays it by key can say so.
 */
import type { AddonStatus, HighResPolicy, RankingSettings, SourceCandidate } from '@multitap/api';
import { YOUTUBE_ID_PREFIX, youtubeStream, type Stream } from '@multitap/addon-protocol';
import {
  addonStatus,
  needsConfiguration,
  type AddonOutcome,
  type AddonService,
} from '../addons/index.ts';
import type { Logger } from '../log.ts';
import { toCandidates, type CandidateWithStream } from './candidates.ts';
import { splitVideoId, type ItemInfo, type ItemMetaLookup } from './item-meta.ts';
import { annotate, type RankEngine } from './rank.ts';
import { itemFlagReasons, type FlagReason } from './safety.ts';
import type { StreamStore } from './stream-store.ts';

export interface SourceListRequest {
  type: string;
  videoId: string;
  engine: RankEngine;
  highRes: HighResPolicy;
  rank: {
    /** The effective ranking settings (RankingSettingsStore.effective()). */
    settings: RankingSettings;
    /** ISO 639-2/B, most preferred first (`resolvePreferredLanguages`); default `["eng"]`. */
    preferredLanguages?: readonly string[] | undefined;
    /** Rank candidates of this `bingeGroup` up (auto-next keeps the release). */
    preferBingeGroup?: string | undefined;
    /** The profile's last source for the video: flagged `lastUsed` and ranked up. */
    lastSource?: string | undefined;
    /** Attach `explain` to each candidate. */
    explain?: boolean | undefined;
  };
}

export interface SourceListDeps {
  addons: AddonService;
  streams: StreamStore;
  /** The item's meta for mismatch scoring and the runtime; without it neither applies. */
  meta?: Pick<ItemMetaLookup, 'lookup'> | undefined;
  /** Where a failing `onPartial` listener is reported (at `debug`). */
  logger?: Logger | undefined;
}

export interface SourceListResult {
  /** Addon order: grouped in collection order, each addon's streams in its own order. */
  candidates: SourceCandidate[];
  addons: AddonStatus[];
  /** What ranking knew about the item (name, episode, runtime), when its meta was found. */
  item?: ItemInfo | undefined;
}

/** The stream a `yt_id:{channel}:{video}` id stands for; none for a bare channel id. */
export function derivedYouTubeStream(videoId: string): Stream | undefined {
  if (!videoId.startsWith(YOUTUBE_ID_PREFIX)) return undefined;
  const [, channel, video] = videoId.split(':');
  if (channel === undefined || channel === '' || video === undefined || video === '') {
    return undefined;
  }
  return youtubeStream(videoId);
}

/** Types whose names and runtimes mean something to ranking; channels and TV get no meta lookup. */
const RANKED_TYPES: ReadonlySet<string> = new Set(['movie', 'series']);

/** One addon's part of an incremental source list (`streams.partial`, okf:concept/addon-aggregation). */
export interface SourcePartial {
  addon: AddonStatus;
  /** This addon's candidates, annotated like the full list, in the addon's order. */
  candidates: SourceCandidate[];
  /** Addons still to answer; 0 on the last partial. */
  remaining: number;
}

export interface StartedSourceList {
  /** How many addons are asked (partials to expect; 0 = none). */
  asked: number;
  /** The full list, once every addon has answered or timed out. */
  done: Promise<SourceListResult>;
}

interface BuiltAddon {
  status: AddonStatus;
  /** The addon's candidates with their streams, in its order, not yet annotated or stored. */
  made: CandidateWithStream[];
}

/**
 * Starts a source list. With `onPartial`, each addon's annotated candidates
 * are reported as the addon answers (after the item's meta lookup, which
 * ranking needs); the full list follows in `done` either way.
 */
export async function startSourceList(
  deps: SourceListDeps,
  request: SourceListRequest,
  onPartial?: (partial: SourcePartial) => void,
): Promise<StartedSourceList> {
  const { type, videoId } = request;
  const index = await deps.addons.collection.index();

  // The meta lookup runs alongside the streams and never fails the list. Ranking
  // only uses it for movies and series; any type may carry streams in its meta.
  const lookup: Promise<ItemInfo | undefined> =
    deps.meta?.lookup(type, videoId).catch(() => undefined) ?? Promise.resolve(undefined);
  const ranked = RANKED_TYPES.has(type);
  const itemPromise: Promise<ItemInfo | undefined> = lookup.then((i) => (ranked ? i : undefined));

  const streamAddons = index.match({ resource: 'stream', type, id: videoId });
  // Partials wait for the setup below (what the meta adds), which the answers may overtake.
  let setupDone: () => void = () => undefined;
  const setup = new Promise<void>((resolve) => {
    setupDone = resolve;
  });
  // Partials go out one at a time, in answer order. Declared before the addons
  // are asked: an answer can arrive while the meta lookup below is awaited.
  let partials: Promise<void> = Promise.resolve();
  let synthetic = false;
  const emit = (outcome: AddonOutcome<'stream'>, remaining: number, own = false): void => {
    if (onPartial === undefined) return;
    partials = partials.then(async () => {
      await setup;
      const item = await itemPromise;
      const one = build(outcome);
      try {
        onPartial({
          addon: one.status,
          candidates: annotateOnce(outcome.addonId, one, item),
          // The synthetic part answers last, so every stream addon's count includes it.
          remaining: remaining + (synthetic && !own ? 1 : 0),
        });
      } catch (err) {
        // A failing listener doesn't fail the list.
        deps.logger?.debug({ err, addonId: outcome.addonId }, 'source list listener failed');
      }
    });
  };
  const asking = deps.addons.aggregate('stream', type, videoId, [], {
    onOutcome: (outcome, remaining) => {
      emit(outcome, remaining);
    },
  });

  // A stream-less addon can still hold streams: those its meta carries for the
  // video (attributed to the addon that served the meta), else the YouTube
  // stream derived from a `yt_id:` id (the first addon serving meta for it).
  // Such an addon gets a part of the list of its own.
  const looked = await lookup;
  const embedded = looked?.embedded;
  const derived = embedded === undefined ? derivedYouTubeStream(videoId) : undefined;
  const extraOwner =
    embedded !== undefined
      ? await deps.addons.collection.get(embedded.addonId)
      : derived === undefined
        ? undefined
        : index.match({ resource: 'meta', type, id: videoId }).find((a) => !needsConfiguration(a));
  const extraStreams: Stream[] = embedded?.streams ?? (derived === undefined ? [] : [derived]);
  synthetic = extraOwner !== undefined && !streamAddons.some((addon) => addon.id === extraOwner.id);
  const asked = streamAddons.length + (synthetic ? 1 : 0);

  const { lastSource, settings } = request.rank;
  // The item is flagged by its meta's name, or by the video's or item's id.
  const { itemId } = splitVideoId(type, videoId);
  const itemReasons: FlagReason[] = itemFlagReasons(
    { id: videoId, name: looked?.target.name },
    settings.safety,
  );
  if (itemId !== videoId && !itemReasons.some((r) => r.rule === 'safety.idPrefixes')) {
    itemReasons.push(...itemFlagReasons({ id: itemId }, settings.safety));
  }

  const built = new Map<string, BuiltAddon>();
  function build(outcome: AddonOutcome<'stream'>): BuiltAddon {
    const cached = built.get(outcome.addonId);
    if (cached !== undefined) return cached;
    const addon = { id: outcome.addonId, name: outcome.addonName };
    let made = toCandidates(addon, outcome.items, { type });
    const invalid = outcome.items.length - made.length;
    if (extraOwner?.id === outcome.addonId) {
      const keys = new Set(made.map((b) => b.candidate.key));
      const fresh = toCandidates(addon, extraStreams, { type }).filter((own) => {
        if (keys.has(own.candidate.key)) return false;
        keys.add(own.candidate.key);
        return true;
      });
      // The derived stream leads (as it always has); the meta's own follow the addon's.
      made = embedded === undefined ? [...fresh, ...made] : [...made, ...fresh];
    }
    // Streams without a usable source can't be keyed or played; they count as dropped.
    const result = { status: addonStatus(outcome, made.length, invalid), made };
    built.set(outcome.addonId, result);
    return result;
  }

  // Each addon's part is annotated once, for its partial or the full list,
  // whichever comes first (annotation is per candidate, so the parts add up to
  // the whole), and its streams are stored then, flags included.
  const annotated = new Map<string, SourceCandidate[]>();
  function annotateOnce(
    addonId: string,
    one: BuiltAddon,
    item: ItemInfo | undefined,
  ): SourceCandidate[] {
    const done = annotated.get(addonId);
    if (done !== undefined) return done;
    const byKey = new Map(one.made.map((m) => [m.candidate.key, m]));
    const out = annotate(
      one.made.map((m) => m.candidate),
      request.engine,
      request.highRes,
      {
        ...request.rank,
        runtimeSec: item?.runtimeSec,
        target: item?.target,
        itemFlagReasons: itemReasons,
      },
    ).map((c): SourceCandidate => {
      const made = byKey.get(c.key);
      if (made !== undefined) {
        deps.streams.put(c.key, {
          addonId,
          addonName: made.candidate.addonName,
          type,
          videoId,
          stream: made.stream,
          requiresEngine: made.candidate.requiresEngine,
          ...(c.flags === undefined ? {} : { flags: c.flags }),
        });
      }
      return c.key === lastSource ? { ...c, lastUsed: true } : c;
    });
    annotated.set(addonId, out);
    return out;
  }
  setupDone();

  const done = (async (): Promise<SourceListResult> => {
    const result = await asking;
    const item = await itemPromise;
    const outcomes: AddonOutcome<'stream'>[] = [...result.addons];
    if (
      synthetic &&
      extraOwner !== undefined &&
      !outcomes.some((o) => o.addonId === extraOwner.id)
    ) {
      const own: AddonOutcome<'stream'> = {
        addonId: extraOwner.id,
        addonName: extraOwner.manifest.name,
        status: 'ok',
        items: [],
        dropped: 0,
      };
      emit(own, 0, true);
      outcomes.push(own);
      const order = new Map((await deps.addons.collection.list()).map((r, i) => [r.id, i]));
      const position = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
      outcomes.sort((a, b) => position(a.addonId) - position(b.addonId));
    }
    await partials;

    const candidates: SourceCandidate[] = [];
    const addons = outcomes.map((outcome) => {
      const one = build(outcome);
      candidates.push(...annotateOnce(outcome.addonId, one, item));
      return one.status;
    });
    return { candidates, addons, item };
  })();
  return { asked, done };
}

export async function listSources(
  deps: SourceListDeps,
  request: SourceListRequest,
): Promise<SourceListResult> {
  return (await startSourceList(deps, request)).done;
}
