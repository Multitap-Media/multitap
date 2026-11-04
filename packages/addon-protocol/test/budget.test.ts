// The addon response budget (okf:architecture/addon-response-budget).
import { describe, expect, it } from 'vitest';
import {
  AddonValidationError,
  checkJsonShape,
  DEFAULT_LIST_LIMITS,
  DEFAULT_MAX_MANIFEST_CATALOGS,
  DEFAULT_MAX_META_VIDEOS,
  DEFAULT_MAX_OBJECT_KEYS,
  fetchManifest,
  ManifestSchema,
  MetaItemSchema,
  parseLenientList,
  parseResourceResponse,
  StreamSchema,
} from '../src/index.ts';

/** `depth` nested arrays around a value. */
function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

function wide(keys: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${String(i)}`, i]));
}

describe('checkJsonShape', () => {
  it('accepts ordinary values and refuses deep or wide ones', () => {
    expect(checkJsonShape({ a: [{ b: 'c' }], d: null })).toBeUndefined();
    expect(checkJsonShape('text')).toBeUndefined();
    expect(checkJsonShape(nested(32))).toBeUndefined();
    expect(checkJsonShape(nested(33))).toMatch(/deeper than 32/);
    expect(checkJsonShape(wide(DEFAULT_MAX_OBJECT_KEYS))).toBeUndefined();
    expect(checkJsonShape({ inner: wide(DEFAULT_MAX_OBJECT_KEYS + 1) })).toMatch(/more than 256/);
  });

  it('checks nesting far past the call stack without recursion', () => {
    const value = JSON.parse(`${'['.repeat(200_000)}${']'.repeat(200_000)}`) as unknown;
    expect(checkJsonShape(value)).toMatch(/deeper than/);
  });
});

describe('parseLenientList with a budget', () => {
  it('reads at most maxItems and counts the rest', () => {
    const result = parseLenientList(StreamSchema, [{ url: 'https://a.example/1' }, {}, {}], {
      maxItems: 1,
    });
    expect(result.success && result.data).toMatchObject({ dropped: [], truncated: 2 });
    expect(result.success && result.data.items).toHaveLength(1);
  });
});

describe('parseResourceResponse within the budget', () => {
  it('keeps the first streams up to the limit, in order', () => {
    const limit = DEFAULT_LIST_LIMITS.streams;
    const streams = Array.from({ length: limit + 5 }, (_, i) => ({
      url: `https://a.example/${String(i)}`,
    }));
    const result = parseResourceResponse({ streams });
    expect(result.success).toBe(true);
    if (!result.success || result.data.response.type !== 'streams') return;
    expect(result.data.response.streams).toHaveLength(limit);
    expect(result.data.response.streams[0]?.url).toBe('https://a.example/0');
    expect(result.data.truncated).toBe(5);
  });

  it('drops a list item with too many keys or too deep before validating it', () => {
    const result = parseResourceResponse({
      streams: [
        { url: 'https://a.example/1', ...wide(DEFAULT_MAX_OBJECT_KEYS) },
        { url: 'https://a.example/2', behaviorHints: { deep: nested(40) } },
        { url: 'https://a.example/3' },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.response.type !== 'streams') return;
    expect(result.data.response.streams.map((s) => s.url)).toEqual(['https://a.example/3']);
    expect(result.data.dropped.map((d) => d.index)).toEqual([0, 1]);
    expect(result.data.dropped[0]?.issues[0]?.message).toMatch(/^Refused: /);
  });

  it('caps every list resource', () => {
    const subtitles = Array.from({ length: DEFAULT_LIST_LIMITS.subtitles + 1 }, (_, i) => ({
      id: String(i),
      url: `https://a.example/${String(i)}.srt`,
      lang: 'en',
    }));
    const result = parseResourceResponse({ subtitles });
    expect(result.success && result.data.truncated).toBe(1);
  });

  it('refuses a meta past the shape limits', () => {
    const result = parseResourceResponse({
      meta: { id: 'tt1', type: 'movie', name: 'X', extra: nested(40) },
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.message).toMatch(/deeper/);
  });

  it('reads only the first videos of a meta', () => {
    const videos = Array.from({ length: DEFAULT_MAX_META_VIDEOS + 10 }, (_, i) => ({
      id: `tt1:1:${String(i + 1)}`,
      title: `Episode ${String(i + 1)}`,
      season: 1,
      episode: i + 1,
    }));
    const meta = MetaItemSchema.parse({ id: 'tt1', type: 'series', name: 'X', videos });
    expect(meta.videos).toHaveLength(DEFAULT_MAX_META_VIDEOS);
  });
});

describe('manifests within the budget', () => {
  const base = { id: 'org.example', version: '1.0.0', name: 'X', types: [], resources: [] };

  it('reads only the first catalogs', () => {
    const catalogs = Array.from({ length: DEFAULT_MAX_MANIFEST_CATALOGS + 10 }, (_, i) => ({
      id: `c${String(i)}`,
      type: 'movie',
    }));
    const manifest = ManifestSchema.parse({ ...base, catalogs, addonCatalogs: catalogs });
    expect(manifest.catalogs).toHaveLength(DEFAULT_MAX_MANIFEST_CATALOGS);
    expect(manifest.addonCatalogs).toHaveLength(DEFAULT_MAX_MANIFEST_CATALOGS);
  });

  it('refuses a manifest nested too deep (it could not be stored as JSON)', async () => {
    const body = `{"id":"org.example","version":"1.0.0","name":"X","types":[],"resources":[],"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    const fakeFetch = () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const error = await fetchManifest('https://addon.example/manifest.json', {
      fetch: fakeFetch,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AddonValidationError);
    expect((error as AddonValidationError).message).toMatch(/deeper than/);
  });
});
