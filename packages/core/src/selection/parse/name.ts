/**
 * Release-name parsing (okf:concept/source-ranking): one release or file name → the
 * fields ranking needs. The heavy lifting is @viren070/parse-torrent-title (a
 * TypeScript port of go-ptt / PTT); this module is the only place that
 * imports it, so replacing or vendoring it touches nothing else. Our own
 * rules run on top for what the library misses or gets wrong for us:
 * container extensions (it reads `.ts` as TeleSync), Dolby Vision profiles,
 * HLG, VC-1/MPEG-2, `W x H` resolutions and bit depth implied by HDR.
 */
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import type { HdrFormat, ReleaseSource, VideoCodec } from '@multitap/api';
import { MULTI_LANGUAGE, normalizeLanguage } from './languages.ts';

/** What a single name tells us. Every field is optional. */
export interface NameInfo {
  height?: number;
  hdr?: HdrFormat;
  dvProfile?: number;
  codec?: VideoCodec;
  bitDepth?: number;
  audio?: string;
  container?: string;
  source?: ReleaseSource;
  languages?: string[];
}

/** Video file extensions we recognise as a container. `mts` is normalized to `m2ts`. */
const CONTAINER_EXT =
  /\.(mkv|mp4|m4v|avi|ts|m2ts|mts|webm|mov|wmv|flv|mpg|mpeg|vob|iso|ogm|divx|3gp)$/i;

const HEIGHT_BY_LABEL: Record<string, number> = { '4k': 2160, '8k': 4320, '2k': 1440 };

/** Library audio labels → our codec names, best first; the first one present wins. */
const AUDIO_PRIORITY: readonly (readonly [string, string])[] = [
  ['TrueHD', 'truehd'],
  ['DTS Lossless', 'dts-hd'],
  ['FLAC', 'flac'],
  ['DDP', 'eac3'],
  ['EAC3', 'eac3'],
  ['DTS Lossy', 'dts'],
  ['AC3', 'ac3'],
  ['DD', 'ac3'],
  ['AAC', 'aac'],
  ['OPUS', 'opus'],
  ['MP3', 'mp3'],
];

const JUNK_SOURCES: Record<string, ReleaseSource> = {
  CAM: 'cam',
  TeleSync: 'telesync',
  TeleCine: 'telecine',
  SCR: 'screener',
  R5: 'screener',
  WORKPRINT: 'workprint',
};

function sourceOf(quality: string | undefined, name: string): ReleaseSource | undefined {
  if (quality === undefined) {
    // `BD1080` (Spanish trackers) is a Blu-ray encode.
    return /\bBD[ .-]?(?:720|1080|2160)p?\b/i.test(name) ? 'bluray' : undefined;
  }
  const junk = JUNK_SOURCES[quality];
  if (junk !== undefined) return junk;
  if (/REMUX/i.test(quality)) return 'remux';
  if (/^(BluRay|BDRip|BRRip|UHDRip|BDMux|BRMux)$/i.test(quality)) return 'bluray';
  if (/^(WEB|WEB-DL|WEBRip|WEB-DLRip|WEBCap|WEBMux|DLMux|HDRip|VODR)$/i.test(quality)) {
    return 'web';
  }
  if (/^(DVD|DVDRip|VHSRip)$/i.test(quality)) return 'dvd';
  // The library reads a bare `HD` as HDTV; only trust an explicit TV marker.
  if (/^(HDTV|SDTV|PDTV|HDTVRip|TVRip|SATRip|PPV|PPVRip)$/i.test(quality)) {
    return /TV|DVB|SAT[ .-]*Rip|PPV/i.test(name) ? 'tv' : undefined;
  }
  return undefined;
}

function heightOf(resolution: string | undefined, name: string): number | undefined {
  const dims = /\b(\d{3,4})\s?[x×]\s?(\d{3,4})\b/i.exec(name);
  if (dims) {
    const w = Number(dims[1]);
    const h = Number(dims[2]);
    // Cropped or ultra-wide frames: class by width (1920 x 800 is a 1080p release).
    // Side-by-side 3D (3840 x 1080) is two 1080p frames, so keep its height.
    return snapHeight(w / h <= 2.5 ? Math.max(h, Math.round((w * 9) / 16)) : h);
  }
  if (resolution === undefined) return undefined;
  const label = HEIGHT_BY_LABEL[resolution.toLowerCase()];
  if (label !== undefined) return label;
  const p = /^(\d{3,4})[pi]$/i.exec(resolution);
  return p ? Number(p[1]) : undefined;
}

const HEIGHT_CLASSES = [240, 360, 480, 576, 720, 1080, 1440, 2160, 4320];

function snapHeight(h: number): number {
  return HEIGHT_CLASSES.find((c) => h <= c * 1.05) ?? h;
}

function codecOf(codec: string | undefined, name: string): VideoCodec | undefined {
  const c = codec?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c !== undefined) {
    if (c === 'avc' || c.endsWith('264')) return 'h264';
    if (c.startsWith('hevc') || c.endsWith('265')) return 'hevc';
    if (c === 'av1') return 'av1';
    if (c === 'vp9') return 'vp9';
    if (c === 'mpeg2') return 'mpeg2';
    if (c === 'xvid' || c === 'divx' || c === 'dvix') return 'xvid';
  }
  if (/\bVC-?1\b/i.test(name)) return 'vc1';
  if (/\bMPEG-?2\b/i.test(name)) return 'mpeg2';
  return undefined;
}

const DV = /\b(?:DV|DoVi|Dolby[ .]?Vision)(?:[ ._-]?(?:P|Profile[ ._]?)?0?[4-9](?:\.\d+)?)?\b/i;
const DV_PROFILE =
  /\b(?:DV|DoVi|Dolby[ .]?Vision)[ ._-]?(?:P|Profile[ ._]?)?0?([4-9])(?:\.\d+)?\b|\bP([578])(?:\.\d+)?[ ._-](?:DV|DoVi)\b/i;

function hdrOf(tags: readonly string[], name: string): HdrFormat | undefined {
  if (tags.includes('DV') || DV.test(name)) return 'dv';
  if (tags.includes('HDR10+') || /HDR10(?:\+|P\b|[ .]?PLUS\b)/i.test(name)) return 'hdr10+';
  if (/\bHLG\b/i.test(name)) return 'hlg';
  if (tags.includes('HDR')) return 'hdr10';
  return undefined;
}

function dvProfileOf(name: string): number | undefined {
  const m = DV_PROFILE.exec(name);
  const digit = m?.[1] ?? m?.[2];
  if (digit !== undefined) return Number(digit);
  // FEL/MEL enhancement layers only exist in profile 7 (UHD Blu-ray).
  if (DV.test(name) && /\b(?:FEL|MEL)\b/.test(name)) return 7;
  return undefined;
}

function bitDepthOf(bitDepth: string | undefined, hdr: HdrFormat | undefined): number | undefined {
  const m = bitDepth === undefined ? null : /(\d+)/.exec(bitDepth);
  if (m) return Number(m[1]);
  // HDR10, HDR10+, HLG and Dolby Vision are all at least 10-bit.
  return hdr === undefined ? undefined : 10;
}

const DISC = /\b(?:UHD|BD|Blu-?Ray)\b/i;

function audioOf(
  audio: readonly string[],
  source: ReleaseSource | undefined,
  name: string,
): string | undefined {
  for (const [label, codec] of AUDIO_PRIORITY) if (audio.includes(label)) return codec;
  // Atmos alone rides on TrueHD on discs and on E-AC-3 on streaming services.
  if (audio.includes('Atmos')) {
    if (source === 'remux' || source === 'bluray') return 'truehd';
    if (source === 'web') return 'eac3';
    if (source === undefined && DISC.test(name)) return 'truehd';
  }
  return undefined;
}

function languagesOf(tokens: readonly string[], name: string): string[] | undefined {
  const out: string[] = [];
  for (const token of tokens) {
    const lang = normalizeLanguage(token);
    if (lang !== undefined && !out.includes(lang)) out.push(lang);
  }
  // `MULTi`, `Multi5`, `DUAL`: several audio tracks, usually including the original.
  if (!out.includes(MULTI_LANGUAGE) && /\bMULTi\d*\b|\bDUAL\b/i.test(name)) {
    out.push(MULTI_LANGUAGE);
  }
  return out.length > 0 ? out : undefined;
}

/** Parses one release or file name. Never throws; unknown fields are left out. */
export function parseReleaseName(raw: string): NameInfo {
  const name = raw.trim();
  if (name === '') return {};
  const ext = CONTAINER_EXT.exec(name);
  const container = ext?.[1]?.toLowerCase();
  // Strip the extension first: the library would read `.ts` as TeleSync.
  const stem = ext ? name.slice(0, ext.index) : name;

  let lib: ReturnType<typeof parseTorrentTitle>;
  try {
    lib = parseTorrentTitle(stem);
  } catch {
    lib = {};
  }

  const hdr = hdrOf(lib.hdr ?? [], stem);
  // Hi10P is 10-bit H.264 (common in anime); the library doesn't know the P form.
  const hi10p = /\bHi10P?\b/i.test(stem);
  const source = sourceOf(lib.quality, stem);
  const info: NameInfo = {
    height: heightOf(lib.resolution, stem),
    hdr,
    dvProfile: hdr === 'dv' ? dvProfileOf(stem) : undefined,
    codec: codecOf(lib.codec, stem) ?? (hi10p ? 'h264' : undefined),
    bitDepth: bitDepthOf(lib.bitDepth ?? (hi10p ? '10bit' : undefined), hdr),
    audio: audioOf(lib.audio ?? [], source, stem),
    container: container === 'mts' ? 'm2ts' : container,
    source,
    languages: languagesOf(lib.languages ?? [], stem),
  };
  return compact(info);
}

/** Drops `undefined` fields, so results compare and serialize cleanly. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
