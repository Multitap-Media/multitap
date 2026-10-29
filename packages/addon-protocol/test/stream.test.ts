import { describe, expect, it } from 'vitest';
import {
  parseResourceResponse,
  StreamSchema,
  StreamSourceSchema,
  streamSourceKind,
  streamSourceVariant,
  youtubeStream,
} from '../src/index.ts';

const HASH = 'df389295484b3059a4726dc6d8a57f71bb5f4c81';

describe('StreamSource variants', () => {
  const cases = [
    ['url', 'url', { url: 'https://example.invalid/video.mp4' }],
    ['youTube', 'youtube', { ytId: 'aqz-KE-bpKQ' }],
    [
      'rar',
      'archive',
      { rarUrls: [['https://example.invalid/a.rar'], ['https://example.invalid/b.rar', 123]] },
    ],
    ['zip', 'archive', { zipUrls: [['https://example.invalid/a.zip', null]], fileIdx: 1 }],
    ['zip7', 'archive', { '7zipUrls': [['https://example.invalid/a.7z']] }],
    ['tgz', 'archive', { tgzUrls: [['https://example.invalid/a.tgz']], fileMustInclude: ['x'] }],
    ['tar', 'archive', { tarUrls: [['https://example.invalid/a.tar']] }],
    [
      'nzb',
      'nzb',
      { nzbUrl: 'https://example.invalid/a.nzb', servers: ['nntps://news.example.invalid:563'] },
    ],
    [
      'torrent',
      'torrent',
      { infoHash: HASH, fileIdx: 2, sources: ['tracker:udp://t.example.invalid:80'] },
    ],
    ['playerFrame', 'playerFrame', { playerFrameUrl: 'https://example.invalid/embed' }],
    ['external', 'external', { externalUrl: 'https://example.invalid/page' }],
    ['external', 'external', { tizenUrl: 'tizen://app' }],
  ] as const;

  it.each(cases)('%s (%s)', (variant, kind, input) => {
    const stream = StreamSchema.parse({ name: 'n', ...input });
    expect(streamSourceVariant(stream)).toBe(variant);
    expect(streamSourceKind(stream)).toBe(kind);
    expect(streamSourceKind(input)).toBe(kind);
    expect(StreamSourceSchema.safeParse(input).success).toBe(true);
  });

  it('applies torrent defaults and aliases', () => {
    const stream = StreamSchema.parse({ infoHash: HASH.toUpperCase(), sources: ['dht:x'] });
    expect(stream).toMatchObject({ infoHash: HASH, announce: ['dht:x'], fileMustInclude: [] });
    expect(StreamSchema.parse({ infoHash: HASH, announce: null })).toMatchObject({ announce: [] });
  });

  it('fills the common defaults', () => {
    const stream = StreamSchema.parse({
      url: 'https://example.invalid/v.mp4',
      name: null,
      description: null,
      thumbnail: null,
      subtitles: null,
      behaviorHints: null,
    });
    expect(stream).toMatchObject({ subtitles: [], behaviorHints: { notWebReady: false } });
    expect(stream.name).toBeUndefined();
  });

  it('reads title as the description', () => {
    expect(StreamSchema.parse({ ytId: 'x', title: 'T' }).description).toBe('T');
    expect(StreamSchema.parse({ ytId: 'x', title: 'T', description: 'D' }).description).toBe('D');
  });

  it('skips invalid subtitles without failing the stream', () => {
    const stream = StreamSchema.parse({
      ytId: 'x',
      subtitles: [
        { id: '1', lang: 'eng', url: 'https://example.invalid/1.srt' },
        { id: '2', lang: 'eng', url: 'not a url' },
        { id: 3 },
      ],
    });
    expect(stream.subtitles.map((s) => s.id)).toEqual(['1']);
  });

  it('keeps unknown fields', () => {
    const stream = StreamSchema.parse({
      ytId: 'x',
      custom: { a: 1 },
      behaviorHints: { other: true, proxyHeaders: { request: { 'User-Agent': 'x' } } },
    });
    expect(stream).toMatchObject({
      custom: { a: 1 },
      behaviorHints: {
        other: true,
        proxyHeaders: { request: { 'User-Agent': 'x' }, response: {} },
      },
    });
  });
});

describe('StreamSource precedence (untagged, first match wins)', () => {
  it('prefers url over infoHash', () => {
    expect(streamSourceVariant({ url: 'https://example.invalid/v', infoHash: HASH })).toBe('url');
  });

  it('falls through an invalid url to the next valid variant', () => {
    expect(streamSourceVariant({ url: 'relative/path', infoHash: HASH })).toBe('torrent');
    expect(streamSourceVariant({ url: 'relative/path', ytId: 'x' })).toBe('youTube');
  });

  it('prefers youtube over archives, archives over nzb, nzb over torrent', () => {
    expect(streamSourceVariant({ ytId: 'x', rarUrls: [['https://example.invalid/a']] })).toBe(
      'youTube',
    );
    expect(
      streamSourceVariant({
        zipUrls: [['https://example.invalid/a']],
        rarUrls: [['https://example.invalid/b']],
      }),
    ).toBe('rar');
    expect(streamSourceVariant({ servers: [], infoHash: HASH })).toBe('nzb');
    expect(streamSourceVariant({ infoHash: HASH, playerFrameUrl: 'https://example.invalid' })).toBe(
      'torrent',
    );
    expect(
      streamSourceVariant({
        playerFrameUrl: 'https://example.invalid',
        externalUrl: 'https://example.invalid',
      }),
    ).toBe('playerFrame');
  });

  it('rejects objects with no valid source', () => {
    for (const input of [
      {},
      { name: 'only a name' },
      { infoHash: 'abc' },
      { infoHash: HASH, fileIdx: 70000 },
      { infoHash: HASH, fileIdx: -1 },
      { rarUrls: [['https://example.invalid/a', 1, 2]] },
      { nzbUrl: 'https://example.invalid/a.nzb' }, // servers is required
      { externalUrl: null, tizenUrl: null },
      { externalUrl: 'not a url' },
    ]) {
      expect(StreamSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
      expect(streamSourceKind(input)).toBeUndefined();
    }
  });

  it('fails the stream on a badly typed common field', () => {
    expect(StreamSchema.safeParse({ ytId: 'x', name: 5 }).success).toBe(false);
    expect(
      StreamSchema.safeParse({ ytId: 'x', behaviorHints: { notWebReady: 'yes' } }).success,
    ).toBe(false);
    expect(StreamSchema.safeParse({ ytId: 'x', behaviorHints: { videoSize: 1.5 } }).success).toBe(
      false,
    );
  });
});

describe('streams responses', () => {
  it('drops invalid items and reports their index', () => {
    const result = parseResourceResponse({
      streams: [
        { url: 'https://example.invalid/1' },
        { name: 'no source' },
        { infoHash: HASH },
        'not an object',
        { ytId: 'x', name: 5 },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { response, dropped } = result.data;
    expect(response.type).toBe('streams');
    if (response.type !== 'streams') return;
    expect(response.streams.map((s) => streamSourceKind(s))).toEqual(['url', 'torrent']);
    expect(dropped.map((d) => d.index)).toEqual([1, 3, 4]);
    expect(dropped.every((d) => d.issues.length > 0)).toBe(true);
  });
});

describe('youtubeStream', () => {
  it('derives the stream from a yt_id video id', () => {
    expect(youtubeStream('yt_id:CHANNEL:VIDEO')?.ytId).toBe('VIDEO');
    expect(youtubeStream('yt_id:CHANNEL')).toBeUndefined();
    expect(youtubeStream('tt123:1:1')).toBeUndefined();
  });
});
