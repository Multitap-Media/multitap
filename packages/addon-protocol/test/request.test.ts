import { describe, expect, it } from 'vitest';
import {
  buildResourceUrl,
  encodeExtra,
  encodeResourcePath,
  encodeUriComponent,
} from '../src/index.ts';

describe('encodeUriComponent (URI_COMPONENT_ENCODE_SET)', () => {
  it("leaves alphanumerics and - _ . ! ~ * ' ( ) alone", () => {
    expect(encodeUriComponent("AZaz09-_.!~*'()")).toBe("AZaz09-_.!~*'()");
  });

  it('encodes everything else as uppercase UTF-8 percent escapes', () => {
    expect(encodeUriComponent(' ')).toBe('%20');
    expect(encodeUriComponent('&=/?#:,+%')).toBe('%26%3D%2F%3F%23%3A%2C%2B%25');
    expect(encodeUriComponent('é')).toBe('%C3%A9');
    expect(encodeUriComponent('日本')).toBe('%E6%97%A5%E6%9C%AC');
    expect(encodeUriComponent('💑')).toBe('%F0%9F%92%91');
  });

  it('replaces lone surrogates instead of throwing', () => {
    expect(encodeUriComponent('a\uD800b')).toBe('a%EF%BF%BDb');
  });
});

describe('encodeExtra (query_params_encode)', () => {
  it('joins encoded pairs in order', () => {
    expect(encodeExtra([])).toBe('');
    expect(encodeExtra([{ name: 'search', value: 'Harry Potter' }])).toBe('search=Harry%20Potter');
    expect(
      encodeExtra([
        { name: 'date', value: '2026-07-02' },
        { name: 'skip', value: '1' },
      ]),
    ).toBe('date=2026-07-02&skip=1');
    expect(encodeExtra([{ name: 'genre', value: 'Beauty & Fashion' }])).toBe(
      'genre=Beauty%20%26%20Fashion',
    );
    expect(encodeExtra([{ name: 'lastVideosIds', value: 'tt1,tt2' }])).toBe(
      'lastVideosIds=tt1%2Ctt2',
    );
  });
});

describe('encodeResourcePath', () => {
  it('omits the extra segment when there is none', () => {
    expect(encodeResourcePath({ resource: 'meta', type: 'series', id: 'tt0903747' })).toBe(
      '/meta/series/tt0903747.json',
    );
    expect(
      encodeResourcePath({ resource: 'stream', type: 'series', id: 'tt0903747:1:1', extra: [] }),
    ).toBe('/stream/series/tt0903747%3A1%3A1.json');
  });

  it('encodes each component', () => {
    expect(encodeResourcePath({ resource: 'meta', type: 'channel', id: 'yt_id:UC x/y' })).toBe(
      '/meta/channel/yt_id%3AUC%20x%2Fy.json',
    );
  });
});

describe('buildResourceUrl', () => {
  const cases = [
    // URLs asserted by stremio-core's own unit tests.
    [
      'https://v3-cinemeta.strem.io/manifest.json',
      {
        resource: 'catalog',
        type: 'movie',
        id: 'top',
        extra: [{ name: 'search', value: 'Harry Potter' }],
      },
      'https://v3-cinemeta.strem.io/catalog/movie/top/search=Harry%20Potter.json',
    ],
    [
      'https://addon/manifest.json',
      {
        resource: 'catalog',
        type: 'series',
        id: 'calendarVideosIds',
        extra: [{ name: 'calendarVideosIds', value: 'tt1' }],
      },
      'https://addon/catalog/series/calendarVideosIds/calendarVideosIds=tt1.json',
    ],
    [
      'https://addon_1.com/manifest.json',
      {
        resource: 'catalog',
        type: 'series',
        id: 'lastVideosIds',
        extra: [{ name: 'lastVideosIds', value: 'tt1' }],
      },
      'https://addon_1.com/catalog/series/lastVideosIds/lastVideosIds=tt1.json',
    ],
    [
      'https://addon/manifest.json',
      {
        resource: 'catalog',
        type: 'tv',
        id: 'guide',
        extra: [
          { name: 'date', value: '2026-07-02' },
          { name: 'skip', value: '1' },
        ],
      },
      'https://addon/catalog/tv/guide/date=2026-07-02&skip=1.json',
    ],
    // Configured addons keep the path prefix and the query string.
    [
      'https://addon.example.invalid/cfg=abc/manifest.json?x=1#frag',
      { resource: 'stream', type: 'movie', id: 'tt1' },
      'https://addon.example.invalid/cfg=abc/stream/movie/tt1.json?x=1',
    ],
  ] as const;

  it.each(cases)('%s → %s', (base, path, expected) => {
    expect(buildResourceUrl(new URL(base), path)?.href).toBe(expected);
  });

  it('refuses transport URLs that do not end in /manifest.json', () => {
    expect(
      buildResourceUrl(new URL('https://addon/stremio/v1'), {
        resource: 'meta',
        type: 'movie',
        id: 'x',
      }),
    ).toBeUndefined();
  });
});
