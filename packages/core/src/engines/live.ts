/**
 * Live HLS through the engine's HLS proxy (okf:architecture/media-gateway "Live",
 * okf:process/phase-4-core-checklist item 9). The engine fetches a playlist with
 * `/proxy/hls/manifest.m3u8?d=…` and rewrites every child to one of its own
 * `/proxy/…` URLs, which carry the upstream URL and, on a protected engine, the
 * proxy password. Neither may reach a player (okf:architecture/secrets-policy), so
 * Multitap rewrites the playlist once more: each child becomes
 * `live/{sealed}.{ext}` under the session's `/media/{token}/`, where `sealed`
 * is the child's upstream URL encrypted for this session.
 *
 * Nothing is kept per segment: the gateway opens the name again and asks the
 * engine for that URL. A playlist with a URL that isn't one of the engine's
 * proxy URLs is refused whole, so nothing unexpected is ever passed on.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** The engine endpoints a rewritten playlist points at. */
export const LIVE_MANIFEST_PATH = '/proxy/hls/manifest.m3u8';
export const LIVE_STREAM_PATH = '/proxy/stream';
const SEGMENT_PATH = /^\/proxy\/stream\/segment\.([A-Za-z0-9]{1,5})$/;

/** Where a live session's child files live under `/media/{token}/`. */
export const LIVE_PREFIX = 'live/';
/** The extension of a key or other opaque file fetched through `/proxy/stream`. */
export const LIVE_OPAQUE_EXT = 'bin';
/** `live/{sealed}.{ext}`: the only live child names the gateway admits. */
export const LIVE_FILE = /^live\/([A-Za-z0-9_-]{40,8192})\.([a-z0-9]{1,5})$/;

/** A playlist larger than this is refused (the engine's own cap is far lower). */
export const LIVE_PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;

/** One child of a live playlist: the upstream URL and the kind of file it is. */
export interface LiveTarget {
  /** Absolute http(s) URL at the origin. Secret. */
  dest: string;
  /** `m3u8` a playlist, `bin` a key, anything else a media segment with that label. */
  ext: string;
}

/** The engine path that serves a target. */
export function liveEndpoint(ext: string): string {
  if (ext === 'm3u8') return LIVE_MANIFEST_PATH;
  if (ext === LIVE_OPAQUE_EXT) return LIVE_STREAM_PATH;
  return `${LIVE_STREAM_PATH}/segment.${ext}`;
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The target of one of the engine's proxy URLs (`…/proxy/hls/manifest.m3u8?d=…`,
 * `…/proxy/stream/segment.ts?d=…`, `…/proxy/stream?d=…`), whatever host the
 * engine put in front. Undefined for anything else.
 */
export function parseEngineProxyUrl(uri: string): LiveTarget | undefined {
  let url: URL;
  try {
    url = new URL(uri, 'http://engine.invalid');
  } catch {
    return undefined;
  }
  let ext: string;
  if (url.pathname === LIVE_MANIFEST_PATH) ext = 'm3u8';
  else if (url.pathname === LIVE_STREAM_PATH) ext = LIVE_OPAQUE_EXT;
  else {
    const segment = SEGMENT_PATH.exec(url.pathname)?.[1]?.toLowerCase();
    // A segment labelled like a playlist or a key would change what its name means.
    if (segment === undefined || segment === 'm3u8' || segment === LIVE_OPAQUE_EXT) {
      return undefined;
    }
    ext = segment;
  }
  const d = url.searchParams.get('d');
  if (d === null || d === '') return undefined;
  // The engine writes base64url; a plain URL is accepted as the engine accepts it.
  let dest = d;
  if (!isHttp(dest)) {
    try {
      dest = Buffer.from(d, 'base64url').toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (!isHttp(dest)) return undefined;
  try {
    return { dest: new URL(dest).toString(), ext };
  } catch {
    return undefined;
  }
}

/**
 * Encrypts live targets into file names and back (AES-256-GCM). The nonce is
 * derived from the content, so one target always gets the same name within a
 * session; the session id is authenticated, so a name only opens under the
 * session it was made for.
 */
export class LiveSealer {
  readonly #key: Buffer;
  readonly #nonceKey: Buffer;

  /** `secret`: the media token secret; without one, a random key for this process. */
  constructor(secret?: string | null) {
    const material = secret == null ? randomBytes(32) : Buffer.from(secret, 'utf8');
    const derive = (info: string) =>
      Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), info, 32));
    this.#key = derive('multitap/live-path/v1/key');
    this.#nonceKey = derive('multitap/live-path/v1/nonce');
  }

  #aad(sid: string, ext: string): Buffer {
    return Buffer.from(`${sid}\u0000${ext}`, 'utf8');
  }

  /** The file name of a target, without the `live/` prefix: `{sealed}.{ext}`. */
  seal(sid: string, target: LiveTarget): string {
    const aad = this.#aad(sid, target.ext);
    const plain = Buffer.from(target.dest, 'utf8');
    const nonce = createHmac('sha256', this.#nonceKey)
      .update(aad)
      .update('\u0000')
      .update(plain)
      .digest()
      .subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    const body = Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64url');
    return `${body}.${target.ext}`;
  }

  /** The target behind a `live/{sealed}.{ext}` name; undefined when it isn't one of this session's. */
  open(sid: string, file: string): LiveTarget | undefined {
    const match = LIVE_FILE.exec(file);
    const body = match?.[1];
    const ext = match?.[2];
    if (body === undefined || ext === undefined) return undefined;
    const raw = Buffer.from(body, 'base64url');
    if (raw.length <= 28) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
      decipher.setAAD(this.#aad(sid, ext));
      decipher.setAuthTag(raw.subarray(12, 28));
      const dest = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      return isHttp(dest) ? { dest, ext } : undefined;
    } catch {
      return undefined;
    }
  }
}

const URI_ATTR = /URI="([^"]*)"/g;

/**
 * Rewrites a playlist the engine's HLS proxy answered: every engine proxy URL
 * (a URI line, or a `URI="…"` attribute) becomes `name(target)`, a path
 * relative to the playlist being served. URIs the engine left alone because
 * they aren't http(s) (`data:`, `skd:`) stay. Undefined when the text isn't a
 * playlist or holds an http(s) URL that isn't one of the engine's proxy URLs.
 */
export function rewriteLivePlaylist(
  text: string,
  name: (target: LiveTarget) => string,
): string | undefined {
  if (!text.trimStart().startsWith('#EXTM3U')) return undefined;
  // Set by `map`; an object, so the checker doesn't take it for a constant.
  const seen = { refused: false };
  const map = (uri: string): string => {
    const target = parseEngineProxyUrl(uri);
    if (target !== undefined) return name(target);
    // Not fetchable over http(s): the engine left it, and so does Multitap.
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !isHttp(uri)) return uri;
    seen.refused = true;
    return uri;
  };
  const lines = text.split('\n').map((raw) => {
    const line = raw.trim();
    if (line === '') return '';
    if (!line.startsWith('#')) return map(line);
    return line.replace(URI_ATTR, (whole, uri: string) =>
      uri === '' ? whole : `URI="${map(uri)}"`,
    );
  });
  return seen.refused ? undefined : lines.join('\n');
}
