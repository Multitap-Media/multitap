/**
 * Addon resource responses. Ported from stremio-core's `types/addon/response.rs`.
 */
import type { z } from 'zod';
import { u64 } from './common.ts';
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
}

/**
 * Validates a list item by item (stremio-core's `VecSkipError`): valid items are
 * kept in order, invalid ones are reported in `dropped`, so one bad item never
 * fails the whole list. `null` or `undefined` is an empty list; anything else
 * that isn't an array is a failure of the whole list.
 */
export function parseLenientList<T extends z.ZodType>(
  schema: T,
  value: unknown,
): { success: true; data: LenientList<z.output<T>> } | { success: false; message: string } {
  if (value === null || value === undefined)
    return { success: true, data: { items: [], dropped: [] } };
  if (!Array.isArray(value)) return { success: false, message: 'Expected an array' };
  const items: z.output<T>[] = [];
  const dropped: DroppedItem[] = [];
  value.forEach((item: unknown, index) => {
    const result = schema.safeParse(item);
    if (result.success) items.push(result.data);
    else dropped.push({ index, issues: result.error.issues });
  });
  return { success: true, data: { items, dropped } };
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
  /** List items dropped by validation (always empty for `meta`). */
  dropped: DroppedItem[];
  cache: ResourceResponseCache;
}

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
 */
export function parseResourceResponse(body: unknown): ResourceResponseResult {
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
    const result = MetaItemSchema.safeParse(value);
    if (!result.success) {
      return { success: false, message: 'Invalid meta', issues: result.error.issues };
    }
    return {
      success: true,
      data: { response: { type: 'meta', meta: result.data }, dropped: [], cache },
    };
  }

  function list<T extends z.ZodType>(
    schema: T,
    wrap: (items: z.output<T>[]) => ResourceResponse,
  ): ResourceResponseResult {
    const result = parseLenientList(schema, value);
    if (!result.success)
      return { success: false, message: `Invalid ${variant}: ${result.message}` };
    const { items, dropped } = result.data;
    return { success: true, data: { response: wrap(items), dropped, cache } };
  }

  switch (key) {
    case 'metas':
      return list(MetaItemPreviewSchema, (metas) => ({ type: 'metas', metas }));
    case 'metasDetailed':
      return list(MetaItemSchema, (metasDetailed) => ({ type: 'metasDetailed', metasDetailed }));
    case 'streams':
      return list(StreamSchema, (streams) => ({ type: 'streams', streams }));
    case 'subtitles':
      return list(SubtitlesSchema, (subtitles) => ({ type: 'subtitles', subtitles }));
    case 'addons':
      return list(DescriptorSchema, (addons) => ({ type: 'addons', addons }));
  }
}
