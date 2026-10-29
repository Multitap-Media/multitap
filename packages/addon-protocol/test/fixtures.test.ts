// Round-trips every captured real addon response (test/fixtures/real/).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  parseResourceResponse,
  streamSourceKind,
  videoStream,
  type ParsedResourceResponse,
} from '../src/index.ts';

const root = join(import.meta.dirname, 'fixtures', 'real');
const addons = ['cinemeta', 'easynews', 'torrentio-public', 'torrentio-rd', 'youtube'];

function load(addon: string, file: string): unknown {
  return JSON.parse(readFileSync(join(root, addon, file), 'utf8')) as unknown;
}

function parse(addon: string, file: string): ParsedResourceResponse {
  const result = parseResourceResponse(load(addon, file));
  if (!result.success) throw new Error(`${addon}/${file}: ${result.message}`);
  return result.data;
}

function streams(addon: string, file: string) {
  const { response } = parse(addon, file);
  if (response.type !== 'streams') throw new Error(`expected streams, got ${response.type}`);
  return response.streams;
}

function meta(addon: string, file: string) {
  const { response } = parse(addon, file);
  if (response.type !== 'meta') throw new Error(`expected meta, got ${response.type}`);
  return response.meta;
}

function metas(addon: string, file: string) {
  const { response } = parse(addon, file);
  if (response.type !== 'metas') throw new Error(`expected metas, got ${response.type}`);
  return response.metas;
}

describe('real fixtures', () => {
  const files = addons.flatMap((addon) =>
    readdirSync(join(root, addon))
      .filter((file) => file.endsWith('.json'))
      .map((file) => [addon, file] as const),
  );

  it('covers every captured addon', () => {
    expect(files.length).toBe(79);
  });

  describe.each(files)('%s/%s', (addon, file) => {
    if (file === 'manifest.json') {
      it('parses as a manifest', () => {
        expect(ManifestSchema.safeParse(load(addon, file)).success).toBe(true);
      });
    } else {
      it('parses with no dropped items', () => {
        const { dropped } = parse(addon, file);
        expect(dropped).toEqual([]);
      });
    }
  });

  it('counts every item', () => {
    const count = (kind: string) =>
      files
        .filter(([, file]) => file.startsWith(kind))
        .reduce((sum, [addon, file]) => {
          const { response } = parse(addon, file);
          if (response.type === 'streams') return sum + response.streams.length;
          if (response.type === 'metas') return sum + response.metas.length;
          return sum + 1;
        }, 0);
    expect({ streams: count('stream-'), metas: count('catalog-'), meta: count('meta-') }).toEqual(
      STREAM_AND_META_COUNTS,
    );
  });
});

// Filled in from the fixture set; a change means a fixture or the schemas changed.
const STREAM_AND_META_COUNTS = { streams: 637, metas: 260, meta: 3 };

describe('manifests', () => {
  it('normalizes Cinemeta catalog extras from the full form', () => {
    const manifest = ManifestSchema.parse(load('cinemeta', 'manifest.json'));
    const year = manifest.catalogs.find((c) => c.type === 'movie' && c.id === 'year');
    expect(year?.extra.map((p) => [p.name, p.isRequired])).toEqual([
      ['genre', true],
      ['skip', false],
    ]);
    const lastVideos = manifest.catalogs.find((c) => c.id === 'last-videos');
    expect(lastVideos?.extra[0]).toMatchObject({
      name: 'lastVideosIds',
      isRequired: true,
      optionsLimit: 100,
    });
    expect(manifest.addonCatalogs.length).toBe(11);
    expect(manifest.idPrefixes).toEqual(['tt']);
  });

  it('keeps unknown manifest fields and reads full-form resources', () => {
    const manifest = ManifestSchema.parse(load('easynews', 'manifest.json'));
    expect(manifest.resources).toEqual([
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
    ]);
    expect(manifest).toHaveProperty('config');
    expect(manifest.behaviorHints).toEqual({
      adult: false,
      p2p: false,
      configurable: false,
      configurationRequired: false,
      epgProvider: false,
    });
  });

  it('reads Torrentio behavior hints', () => {
    const manifest = ManifestSchema.parse(load('torrentio-public', 'manifest.json'));
    expect(manifest.behaviorHints.configurable).toBe(true);
    expect(manifest.catalogs).toEqual([]);
  });
});

describe('Torrentio', () => {
  it('reads public torrent streams', () => {
    const list = streams('torrentio-public', 'stream-series-tt0903747_1_1.json');
    expect(list.length).toBe(20);
    const [first] = list;
    expect(streamSourceKind(first)).toBe('torrent');
    expect(first).toMatchObject({
      name: 'Torrentio\n4k',
      infoHash: 'f0fd1cad0e24b69ff6aaadb9df40c50286327188',
      fileIdx: 0,
      announce: [],
      behaviorHints: {
        bingeGroup: 'torrentio|f0fd1cad0e24b69ff6aaadb9df40c50286327188',
        filename:
          'Breaking Bad (2008) S01E01 (2160p AMZN WEB-DL H265 SDR DDP 5.1 English - HONE).mkv',
        notWebReady: false,
      },
    });
    // `title` is the legacy description.
    expect(first?.description).toMatch(/^Breaking Bad \(2008\) S01/);
    expect(list.every((s) => streamSourceKind(s) === 'torrent')).toBe(true);
  });

  it('reads debrid streams as url streams', () => {
    const list = streams('torrentio-rd', 'stream-series-tt0903747_1_1.json');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => streamSourceKind(s) === 'url')).toBe(true);
    expect(list[0]).toMatchObject({
      url: 'https://example.invalid/redacted/1581',
      behaviorHints: { bingeGroup: 'torrentio|72a391645b5ea76dd6f5ade169ffda943aa81649' },
    });
  });

  it('reads cache hints', () => {
    const { cache } = parse('torrentio-public', 'stream-series-tt0903747_1_1.json');
    expect(Object.keys(cache).sort()).toEqual(['cacheMaxAge', 'staleError', 'staleRevalidate']);
  });
});

describe('Easynews++', () => {
  it('reads not-web-ready url streams', () => {
    const list = streams('easynews', 'stream-series-tt0903747_1_1.json');
    expect(list[0]).toMatchObject({
      name: 'Easynews++\n4K',
      url: 'https://example.invalid/redacted/1689',
      behaviorHints: { notWebReady: true },
    });
    expect(list.every((s) => streamSourceKind(s) === 'url')).toBe(true);
  });
});

describe('Cinemeta', () => {
  it('reads a series with its episodes in order', () => {
    const series = meta('cinemeta', 'meta-series-tt0903747.json');
    expect(series).toMatchObject({ id: 'tt0903747', type: 'series', name: 'Breaking Bad' });
    expect(series.released).toBe('2008-01-20T00:00:00.000Z');
    expect(series.videos.length).toBeGreaterThan(60);
    const first = series.videos[0];
    expect(first).toMatchObject({
      id: 'tt0903747:1:1',
      title: 'Pilot',
      season: 1,
      episode: 1,
      released: '2008-01-21T05:00:00.000Z',
      streams: [],
    });
    // Seasons ascending, specials (season 0) last.
    const seasons = series.videos.map((v) => v.season ?? -1);
    const regular = seasons.filter((s) => s !== 0);
    expect(regular).toEqual([...regular].sort((a, b) => a - b));
    const firstSpecial = seasons.indexOf(0);
    const afterSpecials = firstSpecial === -1 ? [] : seasons.slice(firstSpecial);
    expect(afterSpecials.every((s) => s === 0)).toBe(true);
    expect(series.links.find((l) => l.category === 'imdb')?.name).toBe('9.5');
    expect(series.trailerStreams.map((s) => s.ytId)).toEqual(['VFLkMDEO-Xc', 'XZ8daibM3AE']);
    expect(series.behaviorHints).toMatchObject({ hasScheduledVideos: true, isLive: false });
  });

  it('reads a movie', () => {
    const movie = meta('cinemeta', 'meta-movie-tt1375666.json');
    expect(movie).toMatchObject({ id: 'tt1375666', type: 'movie' });
    expect(movie.posterShape).toBe('poster');
  });

  it('reads catalogs', () => {
    const list = metas('cinemeta', 'catalog-movie-top.json');
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(item.id).toMatch(/^tt\d+$/);
      expect(item.type).toBe('movie');
    }
  });
});

describe('YouTube', () => {
  it('reads a channel catalog', () => {
    const list = metas('youtube', 'catalog-channel-top.json');
    expect(list[0]).toMatchObject({ type: 'channel', name: 'T-Series', posterShape: 'square' });
  });

  it('derives each video stream from its id', () => {
    const channel = meta('youtube', 'meta-channel-first.json');
    expect(channel.videos.length).toBe(250);
    // Channel uploads have no season info, so they're sorted newest first.
    const dates = channel.videos.map((v) => v.released ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
    for (const video of channel.videos) {
      const stream = videoStream(video);
      expect(streamSourceKind(stream)).toBe('youtube');
      expect(stream?.ytId).toBe(video.id.split(':')[2]);
    }
  });
});
