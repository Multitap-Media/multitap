/**
 * Review PoC (selection parsing). Each `it.fails` asserts the CORRECT behaviour;
 * it is expected to fail until the bug is fixed.
 */
import { DEFAULT_RANKING_SETTINGS } from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { HOME_ENGINE } from '../../engine-fixture.ts';
import { annotate, toCandidates } from '../../../src/selection/index.ts';
import { parseSize } from '../../../src/selection/parse/extractors.ts';
import { parseReleaseName } from '../../../src/selection/parse/name.ts';

const engine = { id: HOME_ENGINE.id, capabilities: HOME_ENGINE.capabilities };

function candidateFor(filename: string) {
  const stream = StreamSchema.parse({
    url: 'https://example.com/v.mkv',
    name: 'Example',
    description: filename,
    behaviorHints: { filename },
  });
  const made = toCandidates({ id: 'a', name: 'A' }, [stream]);
  const first = made[0];
  if (!first) throw new Error('expected a candidate');
  return first.candidate;
}

describe('Dolby Vision profile', () => {
  it.fails('an audio channel layout after DV (`DV 5.1`) is not Dolby Vision profile 5', () => {
    const name = 'Movie 2021 2160p WEB-DL DV 5.1 H265.mkv';
    const [annotated] = annotate([candidateFor(name)], engine, 'prepareOnly', {
      settings: DEFAULT_RANKING_SETTINGS,
    });
    expect(annotated?.unplayableReason).not.toBe('dv5');
  });
});

describe('subtitle tags read as audio languages', () => {
  it.fails('`ENG-SUB` (English subtitles) is not English audio', () => {
    expect(parseReleaseName('Show.S01E01.1080p.WEB-DL.KOR.ENG-SUB.mkv').languages).not.toContain(
      'eng',
    );
  });

  it.fails('`VOSTFR` (original audio, French subtitles) is not French audio', () => {
    expect(parseReleaseName('Movie.2020.1080p.VOSTFR.mkv').languages ?? []).not.toContain('fre');
  });

  it.fails('an English-preferring user is not penalised for a VOSTFR release', () => {
    const [annotated] = annotate([candidateFor('Movie.2020.1080p.VOSTFR.mkv')], engine, 'off', {
      settings: DEFAULT_RANKING_SETTINGS,
      preferredLanguages: ['eng'],
      explain: true,
    });
    const rules = annotated?.explain?.contributions.map((c) => c.rule) ?? [];
    expect(rules).not.toContain('language');
  });
});

describe('resolution', () => {
  it.fails('a year followed by a codec (`2020 x264`) is not a 2020x264 frame size', () => {
    // No resolution is stated; the parser reads `2020 x264` as W x H and claims 360p.
    expect(parseReleaseName('Movie Name 2020 x264-GRP').height).toBeUndefined();
  });

  it.fails('a portrait frame (1080 x 1920) is not a 2160p release', () => {
    expect(parseReleaseName('Clip 1080x1920 vertical.mp4').height).toBe(1080);
  });
});

describe('sizes', () => {
  it.fails('a thousands separator is read as part of the number', () => {
    expect(parseSize('1,234.5 MB')).toBe(Math.round(1234.5 * 1024 ** 2));
  });
});
