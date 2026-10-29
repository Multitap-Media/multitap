import { describe, expect, it } from 'vitest';
import {
  decodeSubtitleBytes,
  detectFormat,
  shiftWebVtt,
  SubtitleFormatError,
  toWebVtt,
} from '../src/subtitles/convert.ts';

const vtt = (...cues: string[]) => `WEBVTT\n\n${cues.join('\n\n')}\n`;

describe('toWebVtt: SRT', () => {
  it('converts timestamps and drops cue numbers', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,250',
      'First line',
      'Second line',
      '',
      '2',
      '01:02:03,004 --> 01:02:05,000',
      'Later',
      '',
    ].join('\n');
    expect(toWebVtt(srt)).toBe(
      vtt(
        '00:00:01.000 --> 00:00:04.250\nFirst line\nSecond line',
        '01:02:03.004 --> 01:02:05.000\nLater',
      ),
    );
  });

  it('keeps i/b/u, drops font tags and {\\…} overrides, and escapes the rest', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#ff0000"><I>Red</I></font> & <b>bold</b> a < b > c --> d\n';
    expect(toWebVtt(srt)).toBe(
      vtt('00:00:01.000 --> 00:00:02.000\n<i>Red</i> &amp; <b>bold</b> a &lt; b &gt; c --&gt; d'),
    );
  });

  it('handles a BOM, CRLF and CR line endings', () => {
    const body =
      '1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r00:00:03,000 --> 00:00:04,000\rThere\r';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
    expect(toWebVtt(bytes)).toBe(
      vtt('00:00:01.000 --> 00:00:02.000\nHi', '00:00:03.000 --> 00:00:04.000\nThere'),
    );
  });

  it('copes with missing blank lines, short timestamps and position suffixes', () => {
    const srt = [
      '1',
      '00:01,5 --> 00:02,000 X1:10 X2:20',
      'One',
      '2',
      '00:00:03.000 --> 00:00:04.000',
      'Two',
    ].join('\n');
    expect(toWebVtt(srt)).toBe(
      vtt('00:00:01.500 --> 00:00:02.000\nOne', '00:00:03.000 --> 00:00:04.000\nTwo'),
    );
  });

  it('skips malformed cues and keeps the good ones', () => {
    const srt = [
      '1',
      '00:00:05,000 --> 00:00:04,000',
      'Ends before it starts',
      '',
      '2',
      '00:00:99,000 --> 00:01:00,000',
      'Bad seconds',
      '',
      '3',
      '00:00:06,000 --> 00:00:07,000',
      '',
      '4',
      '00:00:08,000 --> 00:00:09,000',
      'Good',
    ].join('\n');
    expect(toWebVtt(srt)).toBe(vtt('00:00:08.000 --> 00:00:09.000\nGood'));
  });
});

describe('toWebVtt: ASS/SSA', () => {
  const ass = (
    events: string[],
    format = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ) =>
    [
      '[Script Info]',
      'Title: test',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname',
      'Style: Default,Arial',
      '',
      '[Events]',
      `Format: ${format}`,
      ...events,
    ].join('\r\n');

  it('reads Dialogue lines, strips override tags and turns \\N into line breaks', () => {
    const text = ass([
      'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown',
      'Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nnext\\hline',
      'Dialogue: 0,1:00:00.00,1:00:01.00,Default,,0,0,0,,Tom & <Jerry>',
    ]);
    expect(toWebVtt(text)).toBe(
      vtt(
        '00:00:01.500 --> 00:00:03.250\nHello, world\nnext line',
        '01:00:00.000 --> 01:00:01.000\nTom &amp; &lt;Jerry&gt;',
      ),
    );
  });

  it('sorts events by start, honours the Format line and drops drawings', () => {
    const text = ass(
      [
        'Dialogue: 0:00:05.00,0:00:06.00,Default,Second',
        'Dialogue: 0:00:01.00,0:00:02.00,Default,First',
        'Dialogue: 0:00:03.00,0:00:04.00,Default,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
      ],
      'Start, End, Style, Text',
    );
    expect(toWebVtt(text)).toBe(
      vtt('00:00:01.000 --> 00:00:02.000\nFirst', '00:00:05.000 --> 00:00:06.000\nSecond'),
    );
  });

  it('reads SSA v4 files without a Format line', () => {
    const text = [
      '[Script Info]',
      'ScriptType: v4.00',
      '[Events]',
      'Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,NTP,0000,0000,0000,!Effect,Old style',
    ].join('\n');
    expect(detectFormat(text)).toBe('ass');
    expect(toWebVtt(text)).toBe(vtt('00:00:01.000 --> 00:00:02.000\nOld style'));
  });
});

describe('toWebVtt: WebVTT and bad input', () => {
  it('passes WebVTT through with the BOM and line endings normalized', () => {
    const input = '﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n<c.yellow>Hi</c>';
    expect(toWebVtt(input)).toBe('WEBVTT\n\n00:01.000 --> 00:02.000\n<c.yellow>Hi</c>\n');
  });

  it('throws for input with no cues', () => {
    for (const input of [
      '',
      '<html>502 Bad Gateway</html>',
      'just some text\n\nand more',
      '[Events]\n',
    ]) {
      expect(() => toWebVtt(input), input).toThrow(SubtitleFormatError);
    }
    expect(() => toWebVtt(new Uint8Array([0, 1, 2, 255, 254, 0]))).toThrow(SubtitleFormatError);
  });
});

describe('decodeSubtitleBytes', () => {
  it('reads UTF-8, and falls back to latin1 when the bytes are not UTF-8', () => {
    expect(decodeSubtitleBytes(new TextEncoder().encode('Café ✓'))).toBe('Café ✓');
    // "Café" in Windows-1252 / latin1: 0xE9 alone is invalid UTF-8.
    expect(decodeSubtitleBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    const srt = new Uint8Array([
      ...new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nGar'),
      0xe7,
      0x6f,
      0x6e,
      0x0a,
    ]);
    expect(toWebVtt(srt)).toBe(vtt('00:00:01.000 --> 00:00:02.000\nGarçon'));
  });

  it('reads UTF-16 with a BOM and strips a UTF-8 BOM', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeSubtitleBytes(le)).toBe('Hi');
    expect(decodeSubtitleBytes(be)).toBe('Hi');
    expect(decodeSubtitleBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x48]))).toBe('H');
  });
});

describe('toWebVtt: timing offset', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    'First',
    '',
    '2',
    '00:00:10,000 --> 00:00:12,000',
    '<i>Second</i>',
  ].join('\n');
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,First',
    'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Second',
  ].join('\n');

  it('zero is byte-identical to the unshifted output', () => {
    for (const input of [srt, ass, 'WEBVTT\n\n00:01.000 --> 00:02.000 line:0%\nHi']) {
      expect(toWebVtt(input, 0)).toBe(toWebVtt(input));
    }
  });

  it('shifts SRT and ASS cues later', () => {
    const expected = vtt(
      '00:00:03.500 --> 00:00:05.000\nFirst',
      '00:00:12.500 --> 00:00:14.500\n' + (srt.includes('<i>') ? '' : '') + 'Second',
    );
    expect(toWebVtt(ass, 2500)).toBe(expected);
    expect(toWebVtt(srt, 2500)).toBe(
      vtt('00:00:03.500 --> 00:00:05.000\nFirst', '00:00:12.500 --> 00:00:14.500\n<i>Second</i>'),
    );
  });

  it('shifts earlier, clamping a start before 0', () => {
    expect(toWebVtt(srt, -1500)).toBe(
      vtt('00:00:00.000 --> 00:00:01.000\nFirst', '00:00:08.500 --> 00:00:10.500\n<i>Second</i>'),
    );
  });

  it('drops cues that end at or before 0', () => {
    expect(toWebVtt(srt, -2500)).toBe(vtt('00:00:07.500 --> 00:00:09.500\n<i>Second</i>'));
    expect(toWebVtt(ass, -12000)).toBe('WEBVTT\n');
  });

  it('shifts WebVTT input, keeping ids, settings, notes and styles', () => {
    const input = [
      'WEBVTT',
      'NOTE 00:00:01.000 --> 00:00:02.000 is not a cue',
      'STYLE\n::cue { color: red }',
      'intro\n01:00.500 --> 01:02.000 align:start line:0%\nHi',
      '00:00:00.500 --> 00:00:01.000\nGone',
    ].join('\n\n');
    expect(toWebVtt(input, -1000)).toBe(
      [
        'WEBVTT',
        'NOTE 00:00:01.000 --> 00:00:02.000 is not a cue',
        'STYLE\n::cue { color: red }',
        'intro\n00:00:59.500 --> 00:01:01.000 align:start line:0%\nHi',
      ].join('\n\n') + '\n',
    );
  });

  it('shiftWebVtt leaves a zero shift untouched and keeps cue order', () => {
    const doc = vtt('00:00:01.000 --> 00:00:02.000\nA', '00:00:03.000 --> 00:00:04.000\nB');
    expect(shiftWebVtt(doc, 0)).toBe(doc);
    expect(shiftWebVtt(doc, 600_000)).toBe(
      vtt('00:10:01.000 --> 00:10:02.000\nA', '00:10:03.000 --> 00:10:04.000\nB'),
    );
  });
});
