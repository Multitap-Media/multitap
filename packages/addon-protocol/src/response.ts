/**
 * Addon resource responses. Ported from stremio-core's `types/addon/response.rs`.
 */
import type { z } from 'zod';
import { u64 } from './common.ts';
import {
  checkJsonShape,
  DEFAULT_LIST_LIMITS,
  DEFAULT_SHAPE_LIMITS,
  type JsonShapeLimits,
} from './limits.ts';
import { DescriptorSchema, type Descriptor } from './manifest.ts';
import {
  MetaItemPreviewSchema,
  MetaItemSchema,
  type MetaItem,
  type MetaItemPreview,
} from './meta.ts';
import { StreamSchema, type Stream } from './stream.ts';
import { SubtitlesSchema, type Subtitles } from './subtitles.ts';

/** An item left out of a list because it failed validation. */
export interface DroppedItem {
  index: number;
  issues: z.core.$ZodIssue[];
}

export interface LenientList<T> {
  items: T[];
  dropped: DroppedItem[];
  /** Items past `maxItems`, left unread. */
  truncated: number;
}

export interface LenientListOptions {
  /** Items read, in order; the rest are counted in `truncated`. Default: all. */
  maxItems?: number;
  /** Each item's shape limits (okf:architecture/addon-response-budget). Default: none. */
  shape?: JsonShapeLimits;
}

/** A dropped item's issue for a shape the budget refuses. */
function shapeIssue(message: string): z.core.$ZodIssue {
  return { code: 'custom', path: [], message: `Refused: ${message}` };
}

/**
 * Validates a list item by item (stremio-core's `VecSkipError`): valid items are
 * kept in order, invalid ones are reported in `dropped`, so one bad item never
 * fails the whole list. `null` or `undefined` is an empty list; anything else
 * that isn't an array is a failure of the whole list. With `maxItems`, only
 * that many items are read; with `shape`, an item past its limits is dropped
 * before the schema sees it.
 */
export function parseLenientList<T extends z.ZodType>(
  schema: T,
  value: unknown,
  options: LenientListOptions = {},
): { success: true; data: LenientList<z.output<T>> } | { success: false; message: string } {
  if (value === null || value === undefined)
    return { success: true, data: { items: [], dropped: [], truncated: 0 } };
  if (!Array.isArray(value)) return { success: false, message: 'Expected an array' };
  const list = value as unknown[];
  const read = Math.min(list.length, options.maxItems ?? list.length);
  const items: z.output<T>[] = [];
  const dropped: DroppedItem[] = [];
  for (let index = 0; index < read; index++) {
    const item = list[index];
    const refused = options.shape === undefined ? undefined : checkJsonShape(item, options.shape);
    if (refused !== undefined) {
      dropped.push({ index, issues: [shapeIssue(refused)] });
      continue;
    }
    const result = schema.safeParse(item);
    if (result.success) items.push(result.data);
    else dropped.push({ index, issues: result.error.issues });
  }
  return { success: true, data: { items, dropped, truncated: list.length - read } };
}

/** The keys that identify a response variant; exactly one must be present. */
export const RESOURCE_RESPONSE_KEYS = [
  'metas',
  'metasDetailed',
  'meta',
  'streams',
  'subtitles',
  'addons',
] as const;
export type ResourceResponseKey = (typeof RESOURCE_RESPONSE_KEYS)[number];

export type ResourceResponse =
  | { type: 'metas'; metas: MetaItemPreview[] }
  | { type: 'metasDetailed'; metasDetailed: MetaItem[] }
  | { type: 'meta'; meta: MetaItem }
  | { type: 'streams'; streams: Stream[] }
  | { type: 'subtitles'; subtitles: Subtitles[] }
  | { type: 'addons'; addons: Descriptor[] };

/** The SDK's optional cache hints (`ResourceResponseCache`), in seconds. */
export interface ResourceResponseCache {
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
}

export interface ParsedResourceResponse {
  response: ResourceResponse;
  /** List items dropped by validation or the budget's shape limits (always empty for `meta`). */
  dropped: DroppedItem[];
  /** List items past the resource's item limit, left unread (always 0 for `meta`). */
  truncated: number;
  cache: ResourceResponseCache;
}

/** The budget a resource response is parsed under (okf:architecture/addon-response-budget). */
export interface ResourceResponseLimits {
  /** Items kept per list response, by key. */
  listItems: Record<Exclude<ResourceResponseKey, 'meta'>, number>;
  /** Each list item's (and a meta item's) shape limits. */
  shape: JsonShapeLimits;
}

export const DEFAULT_RESOURCE_RESPONSE_LIMITS: ResourceResponseLimits = {
  listItems: DEFAULT_LIST_LIMITS,
  shape: DEFAULT_SHAPE_LIMITS,
};

export type ResourceResponseResult =
  | { success: true; data: ParsedResourceResponse }
  | { success: false; message: string; issues?: z.core.$ZodIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCache(body: Record<string, unknown>): ResourceResponseCache {
  const cache: ResourceResponseCache = {};
  for (const key of ['cacheMaxAge', 'staleRevalidate', 'staleError'] as const) {
    const result = u64.safeParse(body[key]);
    if (result.success) cache[key] = result.data;
  }
  return cache;
}

/**
 * Parses a resource response the way stremio-core's `ResourceResponse`
 * deserializer does:
 * - the body must be an object with exactly one of `RESOURCE_RESPONSE_KEYS`;
 * - list variants skip invalid items (reported in `dropped`) and read `null` as
 *   an empty list;
 * - `meta` must be a valid meta item.
 *
 * Cache hints are read leniently: an invalid value is ignored rather than
 * failing the response.
 *
 * Within the budget (`limits`, default `DEFAULT_RESOURCE_RESPONSE_LIMITS`): a
 * list keeps its first items up to its key's limit and drops items past the
 * shape limits; a meta item past them fails the response.
 */
export function parseResourceResponse(
  body: unknown,
  limits: ResourceResponseLimits = DEFAULT_RESOURCE_RESPONSE_LIMITS,
): ResourceResponseResult {
  if (!isPlainObject(body)) {
    return {
      success: false,
      message: 'Cannot deserialize as ResourceResponse, expected an Object response',
    };
  }
  const present = RESOURCE_RESPONSE_KEYS.filter((key) => Object.hasOwn(body, key));
  const [key] = present;
  if (key === undefined) {
    return {
      success: false,
      message: `Expected one of the keys ${RESOURCE_RESPONSE_KEYS.join(', ')}`,
    };
  }
  if (present.length > 1) {
    return {
      success: false,
      message: `Expected only one of the keys ${RESOURCE_RESPONSE_KEYS.join(', ')}, got ${present.join(', ')}`,
    };
  }
  const cache = parseCache(body);
  const value: unknown = body[key];
  const variant: ResourceResponseKey = key;

  if (key === 'meta') {
    const refused = checkJsonShape(value, limits.shape);
    if (refused !== undefined) return { success: false, message: `Invalid meta: ${refused}` };
    const result = MetaItemSchema.safeParse(value);
    if (!result.success) {
      return { success: false, message: 'Invalid meta', issues: result.error.issues };
    }
    return {
      success: true,
      data: { response: { type: 'meta', meta: result.data }, dropped: [], truncated: 0, cache },
    };
  }

  function list<T extends z.ZodType>(
    schema: T,
    maxItems: number,
    wrap: (items: z.output<T>[]) => ResourceResponse,
  ): ResourceResponseResult {
    const result = parseLenientList(schema, value, { maxItems, shape: limits.shape });
    if (!result.success)
      return { success: false, message: `Invalid ${variant}: ${result.message}` };
    const { items, dropped, truncated } = result.data;
    return { success: true, data: { response: wrap(items), dropped, truncated, cache } };
  }

  const max = limits.listItems;

  switch (key) {
    case 'metas':
      return list(MetaItemPreviewSchema, max.metas, (metas) => ({ type: 'metas', metas }));
    case 'metasDetailed':
      return list(MetaItemSchema, max.metasDetailed, (metasDetailed) => ({
        type: 'metasDetailed',
        metasDetailed,
      }));
    case 'streams':
      return list(StreamSchema, max.streams, (streams) => ({ type: 'streams', streams }));
    case 'subtitles':
      return list(SubtitlesSchema, max.subtitles, (subtitles) => ({
        type: 'subtitles',
        subtitles,
      }));
    case 'addons':
      return list(DescriptorSchema, max.addons, (addons) => ({ type: 'addons', addons }));
  }
}
