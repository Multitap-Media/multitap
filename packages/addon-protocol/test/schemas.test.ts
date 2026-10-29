import { describe, expect, it } from 'vitest';
import {
  DescriptorSchema,
  isExtraSupported,
  isResourceSupported,
  ManifestCatalogSchema,
  ManifestResourceSchema,
  ManifestSchema,
  MetaItemPreviewSchema,
  MetaItemSchema,
  parseLenientList,
  parseResourceResponse,
  SubtitlesSchema,
  VideoSchema,
  videoStream,
} from '../src/index.ts';

const baseManifest = {
  id: 'org.example.addon',
  version: '1.2.3',
  name: 'Example',
  types: ['movie', 'series'],
  resources: ['stream'],
};

describe('ManifestSchema', () => {
  it('applies defaults', () => {
    const manifest = ManifestSchema.parse(baseManifest);
    expect(manifest).toMatchObject({
      catalogs: [],
      addonCatalogs: [],
      behaviorHints: { p2p: false },
    });
    expect(manifest.idPrefixes).toBeUndefined();
    expect(manifest.logo).toBeUndefined();
  });

  it('requires a semver version', () => {
    expect(ManifestSchema.safeParse({ ...baseManifest, version: '1.0' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...baseManifest, version: 'v1.0.0' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...baseManifest, version: '1.0.0-beta.1+b5' }).success).toBe(
      true,
    );
  });

  it('drops invalid logo and background URLs instead of failing', () => {
    const manifest = ManifestSchema.parse({ ...baseManifest, logo: '', background: 'nope' });
    expect(manifest.logo).toBeUndefined();
    expect(manifest.background).toBeUndefined();
  });

  it('requires types and resources', () => {
    expect(ManifestSchema.safeParse({ ...baseManifest, types: undefined }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...baseManifest, resources: undefined }).success).toBe(false);
  });

  it('deduplicates catalogs by (id, type), first wins', () => {
    const manifest = ManifestSchema.parse({
      ...baseManifest,
      catalogs: [
        { id: 'top', type: 'movie', name: 'A' },
        { id: 'top', type: 'movie', name: 'B' },
        { id: 'top', type: 'series', name: 'C' },
      ],
    });
    expect(manifest.catalogs.map((c) => c.name)).toEqual(['A', 'C']);
  });
});

describe('ManifestResourceSchema', () => {
  it('accepts the short and the full form', () => {
    expect(ManifestResourceSchema.parse('meta')).toBe('meta');
    expect(ManifestResourceSchema.parse({ name: 'stream', types: [] })).toMatchObject({
      name: 'stream',
      types: [],
    });
    expect(ManifestResourceSchema.parse({ name: 'stream', types: null })).toEqual({
      name: 'stream',
      types: undefined,
      idPrefixes: undefined,
    });
    expect(ManifestResourceSchema.safeParse({ types: ['movie'] }).success).toBe(false);
  });
});

describe('ManifestCatalogSchema extra', () => {
  it('reads the full form, deduplicated and with skip canonicalized', () => {
    const catalog = ManifestCatalogSchema.parse({
      id: 'top',
      type: 'movie',
      extra: [
        { name: 'genre', options: ['A'], isRequired: true },
        { name: 'genre', options: ['B'] },
        { name: 'skip', options: ['0', '100'], optionsLimit: 5, isRequired: true },
        { name: 'search', options: null },
      ],
      extraSupported: ['ignored'],
    });
    expect(catalog.extra).toEqual([
      { name: 'genre', options: ['A'], isRequired: true, optionsLimit: 1 },
      { name: 'skip', isRequired: false, options: [], optionsLimit: 1 },
      { name: 'search', isRequired: false, options: [], optionsLimit: 1 },
    ]);
  });

  it('reads the legacy short form', () => {
    const catalog = ManifestCatalogSchema.parse({
      id: 'year',
      type: 'movie',
      extraSupported: ['genre', 'skip', 'genre'],
      extraRequired: ['genre', 'notSupported'],
    });
    expect(catalog.extra).toEqual([
      { name: 'genre', isRequired: true, options: [], optionsLimit: 1 },
      { name: 'skip', isRequired: false, options: [], optionsLimit: 1 },
    ]);
  });

  it('falls back to the short form when extra is invalid, and has no extra when neither is set', () => {
    expect(
      ManifestCatalogSchema.parse({
        id: 'a',
        type: 'b',
        extra: [{ nom: 'x' }],
        extraSupported: ['s'],
      }).extra,
    ).toEqual([{ name: 's', isRequired: false, options: [], optionsLimit: 1 }]);
    expect(ManifestCatalogSchema.parse({ id: 'a', type: 'b' }).extra).toEqual([]);
  });

  it('fails when neither form parses', () => {
    expect(
      ManifestCatalogSchema.safeParse({ id: 'a', type: 'b', extraSupported: 'search' }).success,
    ).toBe(false);
  });
});

describe('isExtraSupported / isResourceSupported', () => {
  const manifest = ManifestSchema.parse({
    ...baseManifest,
    idPrefixes: ['tt'],
    resources: ['catalog', { name: 'meta', types: ['series'], idPrefixes: ['kitsu'] }, 'stream'],
    catalogs: [
      {
        id: 'year',
        type: 'movie',
        extra: [{ name: 'genre', isRequired: true }, { name: 'skip' }],
      },
    ],
  });
  const year = manifest.catalogs[0];

  it('checks declared and required extras', () => {
    if (year === undefined) throw new Error('missing catalog');
    expect(isExtraSupported(year, [{ name: 'genre', value: '2020' }])).toBe(true);
    expect(isExtraSupported(year, [])).toBe(false);
    expect(
      isExtraSupported(year, [
        { name: 'genre', value: '1' },
        { name: 'search', value: 'x' },
      ]),
    ).toBe(false);
  });

  it('routes catalogs by type, id and extra', () => {
    const genre = [{ name: 'genre', value: '2020' }];
    expect(
      isResourceSupported(manifest, {
        resource: 'catalog',
        type: 'movie',
        id: 'year',
        extra: genre,
      }),
    ).toBe(true);
    expect(
      isResourceSupported(manifest, {
        resource: 'catalog',
        type: 'series',
        id: 'year',
        extra: genre,
      }),
    ).toBe(false);
    expect(isResourceSupported(manifest, { resource: 'catalog', type: 'movie', id: 'year' })).toBe(
      false,
    );
  });

  it('routes other resources by type and id prefix', () => {
    expect(isResourceSupported(manifest, { resource: 'stream', type: 'movie', id: 'tt1' })).toBe(
      true,
    );
    expect(
      isResourceSupported(manifest, { resource: 'stream', type: 'movie', id: 'kitsu:1' }),
    ).toBe(false);
    expect(isResourceSupported(manifest, { resource: 'stream', type: 'channel', id: 'tt1' })).toBe(
      false,
    );
    expect(isResourceSupported(manifest, { resource: 'meta', type: 'series', id: 'kitsu:1' })).toBe(
      true,
    );
    expect(isResourceSupported(manifest, { resource: 'meta', type: 'movie', id: 'kitsu:1' })).toBe(
      false,
    );
    expect(isResourceSupported(manifest, { resource: 'subtitles', type: 'movie', id: 'tt1' })).toBe(
      false,
    );
    const open = ManifestSchema.parse({ ...baseManifest, idPrefixes: [] });
    expect(isResourceSupported(open, { resource: 'stream', type: 'movie', id: 'anything' })).toBe(
      true,
    );
  });
});

describe('MetaItemPreviewSchema', () => {
  it('applies stremio-core defaults for null and missing fields', () => {
    const item = MetaItemPreviewSchema.parse({
      id: 'tt1',
      type: 'movie',
      name: null,
      posterShape: null,
      links: null,
      trailers: null,
      trailerStreams: null,
      behaviorHints: null,
    });
    expect(item).toMatchObject({
      name: '',
      posterShape: 'poster',
      links: [],
      trailerStreams: [],
      behaviorHints: { isLive: false, hasScheduledVideos: false },
    });
  });

  it('normalizes numbers, dates and poster shapes', () => {
    const item = MetaItemPreviewSchema.parse({
      id: 'tt1',
      type: 'movie',
      releaseInfo: 2010,
      runtime: '148 min',
      imdbRating: 8.8,
      released: 1279065600000,
      posterShape: 'wide',
      poster: '/relative.jpg',
    });
    expect(item).toMatchObject({
      releaseInfo: '2010',
      runtime: '148 min',
      imdbRating: '8.8',
      released: '2010-07-14T00:00:00.000Z',
      posterShape: 'poster',
    });
    expect(item.poster).toBeUndefined();
    expect(
      MetaItemPreviewSchema.parse({ id: 'a', type: 'b', released: '2010-07-14T00:00:00Z' })
        .released,
    ).toBe('2010-07-14T00:00:00.000Z');
    expect(
      MetaItemPreviewSchema.parse({ id: 'a', type: 'b', released: 'July 2010' }).released,
    ).toBeUndefined();
  });

  it('builds trailerStreams from legacy Trailer entries', () => {
    const item = MetaItemPreviewSchema.parse({
      id: 'tt1',
      type: 'movie',
      trailers: [
        { source: 'aaa', type: 'Trailer' },
        { source: 'bbb', type: 'Clip' },
        { ytId: 'ccc' },
      ],
    });
    expect(item.trailerStreams.map((s) => s.ytId)).toEqual(['aaa', 'ccc']);
    expect(
      MetaItemPreviewSchema.safeParse({
        id: 'tt1',
        type: 'movie',
        trailers: [{ url: 'https://example.invalid' }],
      }).success,
    ).toBe(false);
  });

  it('requires id and type, and valid links', () => {
    expect(MetaItemPreviewSchema.safeParse({ type: 'movie' }).success).toBe(false);
    expect(MetaItemPreviewSchema.safeParse({ id: 'tt1' }).success).toBe(false);
    expect(
      MetaItemPreviewSchema.safeParse({
        id: 'a',
        type: 'b',
        links: [{ name: 'x', category: 'y', url: 'bad' }],
      }).success,
    ).toBe(false);
  });
});

describe('VideoSchema and MetaItemSchema videos', () => {
  it('reads aliases and one-or-many streams', () => {
    const video = VideoSchema.parse({ id: 'v', name: 'N', stream: { ytId: 'x' } });
    expect(video.title).toBe('N');
    expect(video.streams.map((s) => s.ytId)).toEqual(['x']);
    expect(VideoSchema.parse({ id: 'v' })).toMatchObject({
      title: '',
      streams: [],
      trailerStreams: [],
    });
    expect(
      videoStream(VideoSchema.parse({ id: 'v', streams: [{ ytId: 'a' }, { ytId: 'b' }] })),
    ).toBeUndefined();
  });

  it('ignores invalid season info instead of failing the video', () => {
    const video = VideoSchema.parse({ id: 'v', season: '1', episode: 2 });
    expect(video.season).toBeUndefined();
    expect(video.episode).toBe(2);
  });

  it('deduplicates, sorts episodes with specials last, and skips invalid videos', () => {
    const meta = MetaItemSchema.parse({
      id: 'tt1',
      type: 'series',
      videos: [
        { id: 's0e1', season: 0, episode: 1 },
        { id: 's2e1', season: 2, episode: 1 },
        { id: 's1e2', season: 1, episode: 2 },
        { id: 's1e1', season: 1, episode: 1 },
        { id: 's1e1', season: 9, episode: 9 },
        { id: 'extra', released: '2020-01-01T00:00:00Z' },
        { season: 1, episode: 3 },
      ],
    });
    expect(meta.videos.map((v) => v.id)).toEqual(['s1e1', 's1e2', 's2e1', 's0e1', 'extra']);
  });

  it('sorts non-episode videos newest first, undated last', () => {
    const meta = MetaItemSchema.parse({
      id: 'yt_id:C',
      type: 'channel',
      videos: [
        { id: 'a', released: '2020-01-01T00:00:00Z' },
        { id: 'none' },
        { id: 'b', released: '2021-01-01T00:00:00Z' },
      ],
    });
    expect(meta.videos.map((v) => v.id)).toEqual(['b', 'a', 'none']);
  });
});

describe('SubtitlesSchema and DescriptorSchema', () => {
  it('validates subtitles', () => {
    expect(
      SubtitlesSchema.parse({ id: '1', lang: 'eng', url: 'https://example.invalid/a.vtt' }),
    ).toMatchObject({
      fonts: [],
    });
    expect(SubtitlesSchema.safeParse({ id: '1', lang: 'eng' }).success).toBe(false);
  });

  it('validates descriptors', () => {
    const descriptor = DescriptorSchema.parse({
      manifest: baseManifest,
      transportUrl: 'https://example.invalid/manifest.json',
    });
    expect(descriptor.flags).toEqual({ official: false, protected: false });
  });
});

describe('parseResourceResponse', () => {
  it('rejects non-objects and bad key sets', () => {
    expect(parseResourceResponse(256).success).toBe(false);
    expect(parseResourceResponse([]).success).toBe(false);
    expect(parseResourceResponse({ unknownVariant: { test: 1 } }).success).toBe(false);
    expect(parseResourceResponse({ metas: [], metasDetailed: [] }).success).toBe(false);
    expect(parseResourceResponse({ metas: { object_key: 'value' } }).success).toBe(false);
  });

  it('reads null lists as empty', () => {
    for (const key of ['metas', 'metasDetailed', 'streams', 'subtitles', 'addons']) {
      const result = parseResourceResponse({ [key]: null });
      expect(result.success && result.data.response.type).toBe(key);
      expect(result.success && result.data.dropped).toEqual([]);
    }
  });

  it('fails the whole response on an invalid meta', () => {
    expect(parseResourceResponse({ meta: { id: 'tt1' } }).success).toBe(false);
    expect(parseResourceResponse({ meta: null }).success).toBe(false);
  });

  it('drops invalid catalog items', () => {
    const result = parseResourceResponse({
      metas: [
        { id: 'tt1', type: 'movie' },
        { id: 5, type: 'movie' },
        { id: 'tt2', type: 'movie' },
      ],
      cacheMaxAge: 3600,
      staleError: 'soon',
    });
    if (!result.success) throw new Error(result.message);
    const { response, dropped, cache } = result.data;
    expect(response.type === 'metas' && response.metas.map((m) => m.id)).toEqual(['tt1', 'tt2']);
    expect(dropped.map((d) => d.index)).toEqual([1]);
    expect(cache).toEqual({ cacheMaxAge: 3600 });
  });

  it('parseLenientList rejects non-arrays', () => {
    expect(parseLenientList(SubtitlesSchema, {}).success).toBe(false);
    expect(parseLenientList(SubtitlesSchema, undefined)).toEqual({
      success: true,
      data: { items: [], dropped: [] },
    });
  });
});
