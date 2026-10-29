import type {
  ExtraValue,
  MetaItem,
  MetaItemPreview,
  ParsedResourceResponse,
  Stream,
  Subtitles,
} from '@multitap/addon-protocol';
import type { AddonCallStatus, AddonClients, CacheOutcome } from './client.ts';
import { needsConfiguration, type AddonCollection, type AddonRecord } from './collection.ts';

/** The item type each aggregated resource yields. */
export interface ResourceItems {
  catalog: MetaItemPreview;
  meta: MetaItem;
  stream: Stream;
  subtitles: Subtitles;
}
export type AggregateResource = keyof ResourceItems;

/** One addon's part of an aggregated request. */
export interface AddonOutcome<R extends AggregateResource> {
  addonId: string;
  /** The manifest's name, for "addon X didn't answer". */
  addonName: string;
  status: AddonCallStatus;
  /**
   * Why a non-`ok` addon failed: the stremio client's error code, or
   * `unexpected-response` when it answered with the wrong kind of response.
   */
  errorCode?: string;
  /** Valid items in the addon's order (a `meta` request yields at most one). */
  items: ResourceItems[R][];
  /** Items the addon sent that failed validation and were left out. */
  dropped: number;
  /** For `ok`: whether it came from the addon (`miss`) or Multitap's cache. */
  cache?: CacheOutcome;
}

export interface AggregateResult<R extends AggregateResource> {
  resource: R;
  type: string;
  id: string;
  extra: ExtraValue[];
  /** Every addon that was asked, in collection order. Addons that don't support the request are not asked. */
  addons: AddonOutcome<R>[];
  /**
   * All items in collection order. Catalog and meta items are deduplicated by
   * `id` (the first addon wins); streams and subtitles are kept exactly as
   * returned, since their order matters.
   */
  items: ResourceItems[R][];
  /** Sum of `dropped` over the addons. */
  dropped: number;
}

export interface AggregateOptions<R extends AggregateResource = AggregateResource> {
  /** Only ask these addons (still subject to enabled + capability matching). */
  addonIds?: readonly string[];
  signal?: AbortSignal;
  /**
   * Called as each addon's outcome arrives (answer order, not collection
   * order), with how many addons are still to answer: incremental source
   * lists (`streams.partial`, okf:concept/addon-aggregation). A throwing callback doesn't fail the call.
   */
  onOutcome?: (outcome: AddonOutcome<R>, remaining: number) => void;
}

type Extracted<R extends AggregateResource> = ResourceItems[R][] | undefined;

/** Pulls the items for `resource` out of a response, or `undefined` if it's the wrong kind. */
function extract<R extends AggregateResource>(
  resource: R,
  data: ParsedResourceResponse,
): Extracted<R> {
  const response = data.response;
  switch (resource) {
    case 'catalog':
      return (response.type === 'metas' ? response.metas : undefined) as Extracted<R>;
    case 'meta':
      return (response.type === 'meta' ? [response.meta] : undefined) as Extracted<R>;
    case 'stream':
      return (response.type === 'streams' ? response.streams : undefined) as Extracted<R>;
    case 'subtitles':
      return (response.type === 'subtitles' ? response.subtitles : undefined) as Extracted<R>;
  }
  return undefined;
}

function merge<R extends AggregateResource>(
  resource: R,
  outcomes: readonly AddonOutcome<R>[],
): ResourceItems[R][] {
  const all = outcomes.flatMap((outcome) => outcome.items);
  if (resource !== 'catalog' && resource !== 'meta') return all;
  const seen = new Set<string>();
  return all.filter((item) => {
    const id = (item as MetaItemPreview).id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Fans a request out to the enabled addons whose manifests support it, all at
 * once, and collects their answers in collection order (okf:concept/addon-aggregation). An addon that
 * fails, times out or has an open circuit is reported in its outcome; the call
 * itself never fails because of an addon.
 */
export async function aggregate<R extends AggregateResource>(
  deps: { collection: AddonCollection; clients: AddonClients },
  resource: R,
  type: string,
  id: string,
  extra: readonly ExtraValue[] = [],
  options: AggregateOptions<R> = {},
): Promise<AggregateResult<R>> {
  const path = { resource, type, id, extra: [...extra] };
  const index = await deps.collection.index();
  let addons: AddonRecord[] = index.match(path);
  if (options.addonIds !== undefined) {
    const wanted = new Set(options.addonIds);
    addons = addons.filter((addon) => wanted.has(addon.id));
  }

  let remaining = addons.length;
  const report = (outcome: AddonOutcome<R>): AddonOutcome<R> => {
    remaining -= 1;
    try {
      options.onOutcome?.(outcome, remaining);
    } catch {
      // The caller's problem; the aggregate result is unaffected.
    }
    return outcome;
  };

  const outcomes = await Promise.all(addons.map(async (addon) => report(await askAddon(addon))));

  async function askAddon(addon: AddonRecord): Promise<AddonOutcome<R>> {
    const base = { addonId: addon.id, addonName: addon.manifest.name };
    // Installed but flagged: asking would only fail every call.
    if (needsConfiguration(addon)) {
      return { ...base, status: 'needs-configuration', items: [], dropped: 0 };
    }
    const result = await deps.clients.request(addon, path, options.signal);
    if (result.status !== 'ok') {
      const outcome: AddonOutcome<R> = { ...base, status: result.status, items: [], dropped: 0 };
      if (result.errorCode !== undefined) outcome.errorCode = result.errorCode;
      return outcome;
    }
    const items = extract(resource, result.data);
    if (items === undefined) {
      return {
        ...base,
        status: 'error',
        errorCode: 'unexpected-response',
        items: [],
        dropped: 0,
      };
    }
    return {
      ...base,
      status: 'ok',
      items,
      dropped: result.data.dropped.length,
      cache: result.cache,
    };
  }

  return {
    resource,
    type,
    id,
    extra: path.extra,
    addons: outcomes,
    items: merge(resource, outcomes),
    dropped: outcomes.reduce((sum, outcome) => sum + outcome.dropped, 0),
  };
}
