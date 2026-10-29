import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParsedSourceSchema } from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import {
  debridCached,
  easynewsInfo,
  parseSize,
  releaseLines,
  torrentioInfo,
} from '../src/selection/parse/extractors.ts';
import { languagesFromFlags, normalizeLanguage } from '../src/selection/parse/languages.ts';
import { parseReleaseName, parseStream } from '../src/selection/index.ts';
import { must, realStreams } from './selection-fixtures.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

interface Labelled {
  category: string;
  name: string;
  synthetic?: boolean;
  expected: Record<string, unknown>;
}

const labelled = JSON.parse(
  readFileSync(join(FIXTURES, 'release-names-labelled.json'), 'utf8'),
) as Labelled[];
const allNames = JSON.parse(readFileSync(join(FIXTURES, 'release-names.json'), 'utf8')) as {
  name: string;
}[];

const FIELDS = [
  'height',
  'hdr',
  'dvProfile',
  'codec',
  'bitDepth',
  'audio',
  'container',
  'source',
  'languages',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const norm = (v: unknown) => JSON.stringify([...((v as string[] | undefined) ?? [])].sort());
    return norm(a) === norm(b);
  }
  return a === b;
}

describe('release-name parser: labelled set', () => {
  it('has at least 120 hand-verified names across the required categories', () => {
    expect(labelled.length).toBeGreaterThanOrEqual(120);
    const categories = new Set(labelled.map((l) => l.category));
    for (const c of ['movie', 'series', 'anime', 'remux', 'dv', 'dv-profile', 'hdr10+', 'm2ts']) {
      expect(categories).toContain(c);
    }
    expect(labelled.some((l) => l.name.endsWith('.ts'))).toBe(true);
    expect(labelled.some((l) => l.expected.source === 'cam')).toBe(true);
    expect(labelled.some((l) => l.expected.source === 'telesync')).toBe(true);
  });

  it('is at least 95% accurate on every field', () => {
    const correct = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<
      (typeof FIELDS)[number],
      number
    >;
    const misses: string[] = [];
    for (const item of labelled) {
      const parsed = parseReleaseName(item.name) as Record<string, unknown>;
      for (const field of FIELDS) {
        if (sameValue(parsed[field], item.expected[field])) correct[field] += 1;
        else {
          misses.push(
            `${field}: got ${JSON.stringify(parsed[field])}, want ${JSON.stringify(item.expected[field])} | ${item.name}`,
          );
        }
      }
    }
    const table = FIELDS.map(
      (f) => `${f.padEnd(10)} ${((100 * correct[f]) / labelled.length).toFixed(1)}%`,
    );
    console.log(
      `parser accuracy on ${String(labelled.length)} labelled names:\n  ${table.join('\n  ')}\nmisses:\n  ${misses.join('\n  ')}`,
    );
    for (const field of FIELDS) {
      expect(correct[field] / labelled.length, field).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('never reads a .ts extension as TeleSync', () => {
    for (const item of labelled.filter((l) => /\.ts$/i.test(l.name))) {
      const parsed = parseReleaseName(item.name);
      expect(parsed.container).toBe('ts');
      expect(parsed.source).not.toBe('telesync');
    }
  });
});

describe('release-name parser: all 3,070 real names', () => {
  it('never throws and always returns schema-valid output, quickly', () => {
    expect(allNames.length).toBe(3070);
    const start = performance.now();
    let withHeight = 0;
    for (const { name } of allNames) {
      const parsed = parseReleaseName(name);
      expect(ParsedSourceSchema.safeParse(parsed).success, name).toBe(true);
      if (parsed.height !== undefined) withHeight += 1;
    }
    const ms = performance.now() - start;
    expect(withHeight / allNames.length).toBeGreaterThan(0.7);
    expect(ms).toBeLessThan(10_000);
  });

  it('handles empty and odd input', () => {
    expect(parseReleaseName('')).toEqual({});
    expect(parseReleaseName('   ')).toEqual({});
    expect(() => parseReleaseName('💾'.repeat(1000))).not.toThrow();
    expect(() => parseReleaseName('.'.repeat(5000))).not.toThrow();
  });
});

describe('name heuristics on top of the library', () => {
  it.each([
    ['Movie.2019.2160p.BluRay.REMUX.DV.P7.FEL.HEVC-G.mkv', { hdr: 'dv', dvProfile: 7 }],
    ['Show.S01E01.2160p.WEB-DL.DV.P5.H.265-G', { hdr: 'dv', dvProfile: 5 }],
    ['Film.2020.2160p.BluRay.x265.DV5.HDR-G', { hdr: 'dv', dvProfile: 5 }],
    ['Movie.2021.2160p.WEB-DL.DoVi.Profile.8.HEVC-G', { hdr: 'dv', dvProfile: 8 }],
    ['Movie.2019.2160p.BluRay.REMUX.DV.FEL.HEVC-G', { hdr: 'dv', dvProfile: 7 }],
    ['Show.2160p.WEB-DL.HLG.HEVC-G', { hdr: 'hlg', bitDepth: 10 }],
    ['Movie.2160p.WEB-DL.HDR10Plus.HEVC-G', { hdr: 'hdr10+' }],
    ['Movie.1080p.BluRay.REMUX.VC-1.DTS-HD.MA-G', { codec: 'vc1', audio: 'dts-hd' }],
    ['Anime.S01E01.1080p.BluRay.Hi10P.FLAC-G', { codec: 'h264', bitDepth: 10 }],
    ['Clip [1920 x 800].mkv', { height: 1080 }],
    ['3D [Full-SBS 3840x1080].mkv', { height: 1080 }],
    ['Stream.00800.MTS', { container: 'm2ts' }],
    ['Movie.2024.MULTi.1080p.WEB.H264-G', { languages: ['mul'] }],
  ])('%s', (name, expected) => {
    expect(parseReleaseName(name)).toMatchObject(expected);
  });
});

describe('extractors', () => {
  it('parses sizes in binary units', () => {
    expect(parseSize('83.5 GB')).toBe(Math.round(83.5 * 1024 ** 3));
    expect(parseSize('700,46 MB')).toBe(Math.round(700.46 * 1024 ** 2));
    expect(parseSize('no size')).toBeUndefined();
  });

  it.each([
    ['[RD+] Torrentio\n4k', true],
    ['[AD+] Torrentio', true],
    ['[TB⚡] Comet', true],
    ['⚡ MediaFusion', true],
    ['[RD download] Torrentio\n1080p', false],
    ['Torrentio\n1080p', undefined],
    [undefined, undefined],
  ])('debrid tag %j → %j', (label, cached) => {
    expect(debridCached(label)).toBe(cached);
  });

  it('reads the Torrentio layout', () => {
    expect(torrentioInfo('Some.Name\n👤 96 💾 83.5 GB ⚙️ ThePirateBay\n🇬🇧 / 🇯🇵 / 🇮🇹')).toEqual({
      seeders: 96,
      sizeBytes: Math.round(83.5 * 1024 ** 3),
      languages: ['eng', 'jpn', 'ita'],
    });
  });

  it('reads the Easynews++ layout', () => {
    expect(
      easynewsInfo('X.mkv\n🕛 2h:34m:30s\n📦 85.6 GB 📅 1418d\n🌐 eng, ger, fre, ita, jpn ⭐'),
    ).toEqual({
      sizeBytes: Math.round(85.6 * 1024 ** 3),
      durationSec: 2 * 3600 + 34 * 60 + 30,
      languages: ['eng', 'ger', 'fre', 'ita', 'jpn'],
    });
    expect(easynewsInfo('🕛 42m:10s').durationSec).toBe(42 * 60 + 10);
  });

  it('picks release lines, file line first', () => {
    expect(releaseLines('Pack Name\nFile.Name.avi\n👤 2 💾 700 MB')).toEqual([
      'File.Name.avi',
      'Pack Name',
    ]);
  });

  it('normalizes languages', () => {
    expect(normalizeLanguage('en')).toBe('eng');
    expect(normalizeLanguage('deu')).toBe('ger');
    expect(normalizeLanguage('es-419')).toBe('spa');
    expect(normalizeLanguage('dual audio')).toBe('mul');
    expect(normalizeLanguage('multi subs')).toBeUndefined();
    expect(languagesFromFlags('🇺🇸 / 🇲🇽 / 🇧🇷')).toEqual(['eng', 'spa', 'por']);
  });
});

describe('parseStream on real addon responses', () => {
  it('Torrentio: seeders, size, languages and filename fields', () => {
    const [first] = realStreams('torrentio-public');
    expect(first).toBeDefined();
    const parsed = parseStream(must(first));
    expect(parsed).toMatchObject({
      height: 2160,
      hdr: 'dv',
      codec: 'hevc',
      container: 'mkv',
      source: 'remux',
      seeders: 96,
    });
    expect(parsed.cached).toBeUndefined();
    expect(parsed.languages?.[0]).toBe('eng');
  });

  it('Torrentio + RD: cached, and the file line wins over the pack name', () => {
    const streams = realStreams('torrentio-rd');
    for (const s of streams) {
      if (s.name?.startsWith('[RD+]')) expect(parseStream(s).cached).toBe(true);
    }
    const pack = streams.find((s) => s.description?.startsWith('Official IMDb Top 250'));
    expect(pack).toBeDefined();
    expect(parseStream(must(pack))).toMatchObject({ container: 'avi', source: 'dvd', seeders: 2 });
  });

  it('Easynews++: size, duration and languages from the description', () => {
    const [first] = realStreams('easynews');
    const parsed = parseStream(must(first));
    expect(parsed).toMatchObject({ height: 2160, hdr: 'dv', container: 'mkv' });
    expect(parsed.durationSec).toBe(2 * 3600 + 34 * 60 + 30);
    expect(parsed.languages).toEqual(['eng', 'ger', 'fre', 'ita', 'jpn']);
    expect(parsed.sizeBytes).toBeGreaterThan(80 * 1024 ** 3);
  });

  it('parses every real stream into schema-valid output', () => {
    for (const addon of ['torrentio-public', 'torrentio-rd', 'easynews'] as const) {
      for (const s of realStreams(addon)) {
        expect(ParsedSourceSchema.safeParse(parseStream(s)).success).toBe(true);
      }
    }
  });

  it('uses videoSize and the label when names say nothing', () => {
    const s = StreamSchema.parse({
      name: 'Easynews++\n1920 x 1080',
      url: 'https://example.invalid/x',
      behaviorHints: { videoSize: 123456789 },
    });
    expect(parseStream(s)).toMatchObject({ height: 1080, sizeBytes: 123456789 });
  });
});
