/**
 * Every regex over addon text runs in linear time, and stream text is capped
 * before Multitap parses it (okf:core-review/sec-input-redos). The first four
 * cases started as the adversarial review's sec-input PoC: before the fix each took
 * seconds on 20k characters, growing with the square of the length. The rest
 * guard the same pattern elsewhere, on inputs large enough that a quadratic
 * regex would take minutes.
 */
import { StreamSchema, STREAM_TEXT_MAX_CHARS } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { mismatchOf, parseRuntime } from '../src/selection/index.ts';
import { parseSize } from '../src/selection/parse/extractors.ts';
import { parseStream } from '../src/selection/parse/index.ts';
import { shiftWebVtt, toWebVtt } from '../src/subtitles/convert.ts';

const N = 20_000;
const LIMIT_MS = 100;
// parseStream runs the whole release-name parser: about 25 ms on its own, but
// past 100 ms under full-suite load; the quadratic version took seconds.
const PARSE_LIMIT_MS = 500;
const BRACE_BACKSLASH = '{' + String.fromCharCode(92);

function ms(fn: () => unknown): number {
  const t = performance.now();
  try {
    fn();
  } catch {
    // Only the time matters.
  }
  return performance.now() - t;
}

it('SRT cue text with unclosed override braces converts in linear time', () => {
  const srt = `1\n00:00:01,000 --> 00:00:02,000\n${BRACE_BACKSLASH.repeat(N)}\n`;
  expect(ms(() => toWebVtt(srt))).toBeLessThan(LIMIT_MS);
});

it('ASS dialogue text with unclosed braces converts in linear time', () => {
  const ass = `[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,${'{'.repeat(N)}\n`;
  expect(ms(() => toWebVtt(ass))).toBeLessThan(LIMIT_MS);
});

it('a stream description of digits parses in linear time (parseSize)', () => {
  expect(ms(() => parseSize('1'.repeat(N)))).toBeLessThan(LIMIT_MS);
});

it('a stream name of unclosed brackets parses in linear time (labelText)', () => {
  expect(ms(() => parseStream({ name: '['.repeat(N) }))).toBeLessThan(PARSE_LIMIT_MS);
});

describe('at a megabyte', () => {
  const BIG = 1024 * 1024;
  // Linear work on a megabyte is milliseconds; quadratic is hours.
  const BIG_LIMIT_MS = 1_000;

  it.each([
    [
      'SRT override braces',
      () => `1\n00:00:01,000 --> 00:00:02,000\n${BRACE_BACKSLASH.repeat(BIG / 2)}\n`,
    ],
    [
      'ASS drawing check',
      () => `[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,{${'\\'.repeat(BIG)}\n`,
    ],
    ['SRT tag soup', () => `1\n00:00:01,000 --> 00:00:02,000\n${'<a'.repeat(BIG / 2)}\n`],
    ['entities', () => `1\n00:00:01,000 --> 00:00:02,000\n${'&'.repeat(BIG)}\n`],
  ])('converts %s in linear time', (_label, input) => {
    const text = input();
    expect(ms(() => toWebVtt(text))).toBeLessThan(BIG_LIMIT_MS);
  });

  it('shifts a WebVTT file with a long run of newlines in linear time', () => {
    const vtt = `WEBVTT\n${'\n'.repeat(BIG)}x`;
    expect(ms(() => shiftWebVtt(vtt, 1000))).toBeLessThan(BIG_LIMIT_MS);
  });

  it.each([
    ['digits', '1'.repeat(BIG)],
    ['a decimal tail', `1.${'1'.repeat(BIG)}`],
    ['spaces after a number', `1${' '.repeat(BIG)}`],
  ])('reads sizes from %s in linear time', (_label, text) => {
    expect(ms(() => parseSize(text))).toBeLessThan(BIG_LIMIT_MS);
  });

  it('reads a runtime of digits in linear time', () => {
    expect(ms(() => parseRuntime(`${'1'.repeat(BIG)}x`))).toBeLessThan(BIG_LIMIT_MS);
  });

  it('matches against an item name with a long run of spaces in linear time', () => {
    const name = `a${' '.repeat(BIG)}b`;
    expect(
      ms(() => mismatchOf({ title: 'Some.Movie.2010.1080p' }, { name, year: 2010 })),
    ).toBeLessThan(BIG_LIMIT_MS);
  });

  it('parses a stream whose text fields are a megabyte each, once the schema caps them', () => {
    const long = '1'.repeat(BIG);
    const stream = StreamSchema.parse({
      url: 'https://example.invalid/1',
      name: '['.repeat(BIG),
      description: `💾 ${long}\n${long}`,
      behaviorHints: { filename: long, bingeGroup: long },
    });
    expect(stream.name).toHaveLength(STREAM_TEXT_MAX_CHARS);
    expect(stream.description).toHaveLength(STREAM_TEXT_MAX_CHARS);
    expect(stream.behaviorHints.filename).toHaveLength(STREAM_TEXT_MAX_CHARS);
    expect(ms(() => parseStream(stream))).toBeLessThan(BIG_LIMIT_MS);
  });
});

describe('the linear patterns read what they did before', () => {
  it('strips SRT override blocks and ASS tags', () => {
    const srt = toWebVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Hello {\\i1}there\n');
    expect(srt).toContain('Hello there');
    const ass = toWebVtt(
      '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,{\\b1}Bold{\\b0} text\n',
    );
    expect(ass).toContain('Bold text');
    expect(
      toWebVtt(
        '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,{\\p1}m 0 0 l 1 1{\\p0}\nDialogue: 0,0:00:03.00,0:00:04.00,,,0,0,0,,Text\n',
      ),
    ).not.toContain('m 0 0');
  });

  it('reads sizes and runtimes', () => {
    expect(parseSize('👤 96 💾 83.5 GB ⚙️ ThePirateBay')).toBe(Math.round(83.5 * 1024 ** 3));
    expect(parseSize('size 1,5 GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('x264-12 700 MB')).toBe(700 * 1024 ** 2);
    expect(parseRuntime('2h 28min')).toBe(2 * 3600 + 28 * 60);
    expect(parseRuntime('1.5 hours')).toBe(5400);
  });

  it('drops bracketed tags from a stream label', () => {
    // `[2160p]` would win over the label's 1080 if the tag were read.
    expect(parseStream({ name: '[RD+] [2160p] Easynews++\n1920 x 1080' })).toMatchObject({
      height: 1080,
      cached: true,
    });
  });

  it('matches titles with a year or a subtitle', () => {
    expect(
      mismatchOf({ title: 'Inception.2010.1080p.BluRay' }, { name: 'Inception (2010)' }),
    ).toBeUndefined();
    expect(
      mismatchOf(
        { title: 'Mission.Impossible.2023.2160p' },
        { name: 'Mission: Impossible – Dead Reckoning' },
      ),
    ).toBeUndefined();
  });
});
