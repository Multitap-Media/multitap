/**
 * `subtitles/convert`: SRT, ASS/SSA and WebVTT in, WebVTT out (see
 * okf:concept/addon-aggregation). Deliberately small: timing and text only. ASS styling, positioning and
 * drawings are dropped; SRT's `<i>`, `<b>` and `<u>` are kept, since WebVTT has
 * the same tags.
 *
 * Bytes are decoded as UTF-8 (or UTF-16 with a BOM), falling back to
 * Windows-1252/latin1 when they aren't valid UTF-8.
 *
 * Files come from addons, so every pattern runs in linear time
 * (okf:core-review/sec-input-redos): a brace class never spans the opening
 * brace it looks for, and nothing unanchored rescans the input from each start.
 */
import { SUBTITLE_OFFSET_MAX_MS } from '@multitap/api';

/** The input has no cues in any supported format. */
export class SubtitleFormatError extends Error {
  override name = 'SubtitleFormatError';
}

export type SubtitleFormat = 'vtt' | 'ass' | 'srt';

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Decodes subtitle file bytes to text, without a BOM. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      // Not UTF-8: older subtitles are mostly Windows-1252 (the WHATWG `latin1`).
      text = new TextDecoder('latin1').decode(bytes);
    }
  }
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** Strips a BOM and turns CRLF / CR line endings into LF. */
function normalize(text: string): string {
  return (text.startsWith('﻿') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

export function detectFormat(text: string): SubtitleFormat {
  const normalized = normalize(text);
  if (/^WEBVTT(?:[ \t]|\n|$)/.test(normalized)) return 'vtt';
  if (/^[ \t]*\[(?:Script Info|Events|V4\+? Styles)\][ \t]*$/im.test(normalized)) return 'ass';
  return 'srt';
}

/**
 * `[h:]mm:ss[,.]fff` → milliseconds. The fraction is read as a fraction, so
 * ASS centiseconds (`0:00:01.50`) and SRT milliseconds (`00:00:01,500`) agree.
 */
function parseTimestamp(value: string): number | undefined {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (match === null) return undefined;
  const [, h = '0', m = '0', s = '0', frac = ''] = match;
  const minutes = Number(m);
  const seconds = Number(s);
  if (minutes > 59 || seconds > 59) return undefined;
  const ms = frac === '' ? 0 : Math.round(Number(`0.${frac}`) * 1000);
  return ((Number(h) * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

function formatTimestamp(totalMs: number): string {
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

const ENTITY = /^&(?:amp|lt|gt|nbsp|lrm|rlm|#\d{1,7}|#x[\da-f]{1,6});/i;

/** Escapes text for a WebVTT cue: `&`, `<` and `>` (existing entities are kept). */
function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '&') out += ENTITY.test(text.slice(i)) ? '&' : '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else out += ch;
  }
  return out;
}

/** Trims each line and drops empty ones; `undefined` if nothing is left. */
function tidyLines(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? undefined : lines.join('\n');
}

const KEPT_TAGS = new Set(['i', 'b', 'u']);

/** SRT cue text: keeps `<i>`, `<b>`, `<u>`; drops other tags and ASS-style `{\…}` overrides; escapes the rest. */
function srtText(raw: string): string | undefined {
  const withoutOverrides = raw.replace(/\{\\[^{}]*\}/g, '');
  let out = '';
  let last = 0;
  for (const match of withoutOverrides.matchAll(/<(\/?)([a-z]+)\b[^<>]*>/gi)) {
    out += escapeText(withoutOverrides.slice(last, match.index));
    const [, close = '', name = ''] = match;
    const tag = name.toLowerCase();
    if (KEPT_TAGS.has(tag)) out += `<${close}${tag}>`;
    else if (tag === 'br') out += '\n';
    last = match.index + match[0].length;
  }
  out += escapeText(withoutOverrides.slice(last));
  return tidyLines(out);
}

const TIMING_LINE =
  /^\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)(?:\s.*)?$/;

/** SRT, read leniently: any `start --> end` line starts a cue, which runs to the next blank line. */
function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  let current: { startMs: number; endMs: number; lines: string[] } | undefined;
  const finish = () => {
    if (current === undefined) return;
    const cueText = srtText(current.lines.join('\n'));
    if (cueText !== undefined && current.endMs > current.startMs) {
      cues.push({ startMs: current.startMs, endMs: current.endMs, text: cueText });
    }
    current = undefined;
  };
  for (const line of text.split('\n')) {
    const timing = TIMING_LINE.exec(line);
    if (timing !== null) {
      const startMs = parseTimestamp(timing[1] ?? '');
      const endMs = parseTimestamp(timing[2] ?? '');
      if (startMs !== undefined && endMs !== undefined) {
        // A cue number left on the previous cue when the blank line was missing.
        if (current !== undefined && /^\s*\d+\s*$/.test(current.lines.at(-1) ?? '')) {
          current.lines.pop();
        }
        finish();
        current = { startMs, endMs, lines: [] };
        continue;
      }
    }
    if (current === undefined) continue; // cue numbers and anything outside a cue
    if (line.trim() === '') finish();
    else current.lines.push(line);
  }
  finish();
  return cues;
}

/** Fields of a Dialogue line when the file has no `Format:` line (ASS v4+ and SSA v4 agree on the ones used). */
const DEFAULT_ASS_FORMAT = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

/** ASS cue text: override blocks stripped, `\N` / `\n` as line breaks, `\h` as a space. */
function assText(raw: string): string | undefined {
  // A drawing (`{\p1}` …) is vector art, not text.
  if (/\{[^{}]*\\p[1-9]/.test(raw)) return undefined;
  const plain = raw
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ');
  return tidyLines(escapeText(plain));
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let section = '';
  let format = DEFAULT_ASS_FORMAT;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? '').trim().toLowerCase();
      continue;
    }
    if (section !== 'events') continue;
    const field = /^([A-Za-z]+):\s?(.*)$/.exec(line);
    if (field === null) continue;
    const [, kind = '', rest = ''] = field;
    if (kind.toLowerCase() === 'format') {
      const names = rest.split(',').map((name) => name.trim().toLowerCase());
      if (names.includes('start') && names.includes('end') && names.at(-1) === 'text') {
        format = names;
      }
      continue;
    }
    if (kind.toLowerCase() !== 'dialogue') continue;
    // Text is the last field and may itself contain commas.
    const parts = rest.split(',');
    if (parts.length < format.length) continue;
    const values = [...parts.slice(0, format.length - 1), parts.slice(format.length - 1).join(',')];
    const get = (name: string) => values[format.indexOf(name)] ?? '';
    const startMs = parseTimestamp(get('start'));
    const endMs = parseTimestamp(get('end'));
    const cueText = assText(get('text'));
    if (startMs === undefined || endMs === undefined || endMs <= startMs) continue;
    if (cueText === undefined) continue;
    cues.push({ startMs, endMs, text: cueText });
  }
  // ASS events can be in any order; WebVTT cues must start in order. The sort is stable.
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export { SUBTITLE_OFFSET_MAX_MS };

/** Clamps a (sum of) offset(s) to ±{@link SUBTITLE_OFFSET_MAX_MS}. */
export function clampSubtitleOffset(offsetMs: number): number {
  return Math.max(-SUBTITLE_OFFSET_MAX_MS, Math.min(SUBTITLE_OFFSET_MAX_MS, offsetMs));
}

/** `text` without its trailing newlines (a loop: `/\n+$/` is quadratic on a long run). */
function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(0, end);
}

const SHIFT_TIMING =
  /^(\s*)((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)((?:\s.*)?)$/;

/**
 * Shifts every cue of a WebVTT document by `offsetMs` (signed milliseconds,
 * the unit of the engine's `/subtitles.vtt?offset=`). A start that falls
 * before 0 is clamped to 0; a cue that ends at or before 0 is dropped (the
 * engine keeps it as an empty cue, which a player would never show anyway).
 * Cue ids, settings, notes, styles and regions are kept; 0 returns `vtt`
 * unchanged.
 */
export function shiftWebVtt(vtt: string, offsetMs: number): string {
  if (offsetMs === 0) return vtt;
  const blocks = trimTrailingNewlines(normalize(vtt)).split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0 || at > 1 || /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block)) {
      kept.push(block);
      continue;
    }
    const timing = SHIFT_TIMING.exec(lines[at] ?? '');
    const start = parseTimestamp(timing?.[2] ?? '');
    const end = parseTimestamp(timing?.[3] ?? '');
    if (timing === null || start === undefined || end === undefined) {
      kept.push(block);
      continue;
    }
    if (end + offsetMs <= 0) continue;
    lines[at] =
      `${formatTimestamp(Math.max(0, start + offsetMs))} --> ` +
      `${formatTimestamp(end + offsetMs)}${timing[4] ?? ''}`;
    kept.push(lines.join('\n'));
  }
  return `${kept.join('\n\n')}\n`;
}

/**
 * Converts a subtitle file to WebVTT, shifted by `offsetMs` (see
 * {@link shiftWebVtt}). WebVTT input is passed through with its BOM and line
 * endings normalized.
 *
 * @throws {SubtitleFormatError} when no cue can be read.
 */
export function toWebVtt(input: Uint8Array | string, offsetMs = 0): string {
  return shiftWebVtt(convertToWebVtt(input), offsetMs);
}

function convertToWebVtt(input: Uint8Array | string): string {
  const text = normalize(typeof input === 'string' ? input : decodeSubtitleBytes(input));
  const format = detectFormat(text);
  if (format === 'vtt') return text.endsWith('\n') ? text : `${text}\n`;
  const cues = format === 'ass' ? parseAss(text) : parseSrt(text);
  if (cues.length === 0) {
    throw new SubtitleFormatError(`No ${format.toUpperCase()} cues could be read.`);
  }
  const body = cues
    .map((cue) => `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}
