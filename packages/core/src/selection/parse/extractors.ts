/**
 * Information addons put outside the release name. Addon-agnostic heuristics
 * come first; the per-format extractors below them recognise a layout by its
 * markers, never by addon id, so a fork or a clone using the same layout works.
 */
import { languagesFromFlags, normalizeLanguage } from './languages.ts';

/** Stream fields the extractors read. Structural, so raw and parsed streams both fit. */
export interface StreamText {
  name?: string | undefined;
  description?: string | undefined;
  title?: string | undefined;
  behaviorHints?:
    | {
        filename?: string | undefined;
        videoSize?: number | undefined;
        bingeGroup?: string | undefined;
      }
    | undefined;
}

export interface ExtractedInfo {
  sizeBytes?: number;
  durationSec?: number;
  seeders?: number;
  cached?: boolean;
  languages?: string[];
}

const UNIT: Record<string, number> = {
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};
/**
 * A match starts only where a number starts, and numbers are bounded: an
 * unanchored `\d+` rescans a run of digits from each of its positions, which
 * is quadratic on addon text.
 */
const SIZE = /(?<!\d)(\d{1,15}(?:[.,]\d{1,15})?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i;

/** `83.5 GB` → bytes (binary units, as addons compute them). */
export function parseSize(text: string): number | undefined {
  const m = SIZE.exec(text);
  if (!m?.[1] || !m[2]) return undefined;
  const unit = UNIT[m[2].toLowerCase()];
  return unit === undefined ? undefined : Math.round(Number(m[1].replace(',', '.')) * unit);
}

/** A line that starts with an emoji is addon metadata, not a release name. */
const META_LINE = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/**
 * Release-name candidates from the description, best first: the last plain
 * line is the file when a pack name precedes it (Torrentio), else the only one.
 */
export function releaseLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !META_LINE.test(line))
    .reverse();
}

// ---- Addon-agnostic heuristics -------------------------------------------

/**
 * Debrid cache tags in the stream's label: `[RD+]`, `[AD+]`, `[TB⚡]`, a bare
 * `⚡` mean cached (instant); `[RD download]` and an hourglass (`⏳`, `⌛`:
 * MediaFusion's uncached marker) mean the debrid service still has to fetch
 * it. Torrentio started the convention; many addons copy it. Anything else
 * stays unknown.
 */
export function debridCached(label: string | undefined): boolean | undefined {
  if (label === undefined) return undefined;
  if (/\[[A-Za-z]{2,4}\s+download\]/i.test(label)) return false;
  if (/[⏳⌛]/u.test(label)) return false;
  if (/\[[A-Za-z]{2,4}(?:\+|⚡)\]|⚡/u.test(label)) return true;
  return undefined;
}

function genericInfo(stream: StreamText): ExtractedInfo {
  const videoSize = stream.behaviorHints?.videoSize;
  return {
    sizeBytes: videoSize !== undefined && videoSize > 0 ? videoSize : undefined,
    cached: debridCached(stream.name),
  };
}

// ---- Per-format extractors -----------------------------------------------

/** Torrentio layout: `👤 96 💾 83.5 GB ⚙️ ThePirateBay`, then a line of flags. */
export function torrentioInfo(text: string): ExtractedInfo {
  const seeders = /👤\s*(\d+)/u.exec(text);
  const size = /💾\s*([^⚙\n]+)/u.exec(text);
  const flags = languagesFromFlags(text);
  return {
    seeders: seeders?.[1] === undefined ? undefined : Number(seeders[1]),
    sizeBytes: size?.[1] === undefined ? undefined : parseSize(size[1]),
    languages: flags.length > 0 ? flags : undefined,
  };
}

/** Easynews++ layout: `🕛 2h:34m:30s`, `📦 85.6 GB 📅 1418d`, `🌐 eng, ger ⭐`. */
export function easynewsInfo(text: string): ExtractedInfo {
  const size = /📦\s*([^📅\n]+)/u.exec(text);
  const duration = /🕛\s*(?:(\d+)h:)?(\d+)m:(\d+)s/u.exec(text);
  const langs = /🌐\s*([^\n⭐]+)/u.exec(text);
  const languages = (langs?.[1] ?? '')
    .split(/[,\s]+/)
    .map((token) => normalizeLanguage(token))
    .filter((lang): lang is string => lang !== undefined);
  return {
    sizeBytes: size?.[1] === undefined ? undefined : parseSize(size[1]),
    durationSec: duration
      ? Number(duration[1] ?? 0) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : undefined,
    languages: languages.length > 0 ? [...new Set(languages)] : undefined,
  };
}

/** Everything extractable outside the release names, best source first per field. */
export function extractInfo(stream: StreamText): ExtractedInfo[] {
  const text = [stream.description ?? stream.title ?? '', stream.name ?? ''].join('\n');
  const out: ExtractedInfo[] = [genericInfo(stream)];
  if (/[👤💾]/u.test(text)) out.push(torrentioInfo(text));
  if (/[📦🕛🌐]/u.test(text)) out.push(easynewsInfo(text));
  // Last resort: any size mentioned anywhere.
  const size = parseSize(text);
  if (size !== undefined) out.push({ sizeBytes: size });
  return out;
}
