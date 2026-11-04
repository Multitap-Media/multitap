/**
 * The addon response budget (okf:architecture/addon-response-budget).
 *
 * The response size cap bounds an addon's bytes, not the work they cost: 8 MiB
 * is enough for hundreds of thousands of tiny streams, one object with half a
 * million keys, or nesting deep enough to make `JSON.stringify` throw. So
 * before anything is validated:
 *
 * - a list response keeps at most its resource's item count, in the addon's
 *   order (stremio addons sort best first), and reports the rest as
 *   `truncated`;
 * - each list item, meta item and manifest must stay within a nesting depth and
 *   a number of keys per object, or it's refused as a whole (a list item is
 *   dropped, like any other invalid item).
 *
 * The defaults sit far above what real addons send.
 */

/** List items kept per response, by response key. */
export const DEFAULT_LIST_LIMITS = {
  metas: 1_000,
  metasDetailed: 200,
  streams: 1_000,
  subtitles: 500,
  addons: 1_000,
} as const satisfies Record<string, number>;

/** Videos kept per meta item. */
export const DEFAULT_MAX_META_VIDEOS = 20_000;

/** Catalogs (and addon catalogs) kept per manifest. */
export const DEFAULT_MAX_MANIFEST_CATALOGS = 500;

/** Deepest nesting of arrays and objects accepted in one item (the item itself is depth 1). */
export const DEFAULT_MAX_DEPTH = 32;

/** Most keys accepted on one object. */
export const DEFAULT_MAX_OBJECT_KEYS = 256;

export interface JsonShapeLimits {
  maxDepth: number;
  maxObjectKeys: number;
}

export const DEFAULT_SHAPE_LIMITS: JsonShapeLimits = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxObjectKeys: DEFAULT_MAX_OBJECT_KEYS,
};

/**
 * Checks a parsed JSON value against the shape limits without recursion (so
 * any depth is safe to check). Returns why it's refused, or `undefined` when
 * it fits. Arrays aren't limited here: their length is bounded by the bytes,
 * and the lists that matter are capped by count.
 */
export function checkJsonShape(
  value: unknown,
  limits: JsonShapeLimits = DEFAULT_SHAPE_LIMITS,
): string | undefined {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value: current, depth } = next;
    if (typeof current !== 'object' || current === null) continue;
    if (depth > limits.maxDepth) return `nested deeper than ${String(limits.maxDepth)} levels`;
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) {
        if (typeof item === 'object' && item !== null)
          stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    let keys = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (++keys > limits.maxObjectKeys) {
        return `an object has more than ${String(limits.maxObjectKeys)} keys`;
      }
      const item = (current as Record<string, unknown>)[key];
      if (typeof item === 'object' && item !== null) stack.push({ value: item, depth: depth + 1 });
    }
  }
  return undefined;
}
