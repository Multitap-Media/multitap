/**
 * `selection/candidates`: (addon, raw Stream) → `SourceCandidate` (see
 * okf:architecture/normalized-addon-types). Engine-independent: `playable`, `score` and `playableWhen` are filled
 * in for a target engine by `rank.annotate`.
 */
import { createHash } from 'node:crypto';
import { MAX_BINGE_GROUP_LENGTH, type SourceCandidate, type SourceKind } from '@multitap/api';
import {
  streamSourceVariant,
  type Stream,
  type StreamSourceVariant,
} from '@multitap/addon-protocol';
import { parseStream } from './parse/index.ts';

/** The addon a stream came from. */
export interface CandidateAddon {
  id: string;
  name: string;
  /** Set when the addon is an engine's local addon: its streams only play there (okf:architecture/future-remote-engines). */
  engineId?: string | undefined;
}

export interface CandidateOptions {
  /** The request's content type; `tv` and `channel` URL streams are live. */
  type?: string | undefined;
}

/** A candidate with the raw stream Multitap keeps for it. */
export interface CandidateWithStream {
  candidate: SourceCandidate;
  stream: Stream;
}

const KIND_BY_VARIANT: Record<StreamSourceVariant, SourceKind> = {
  url: 'http',
  youTube: 'youtube',
  torrent: 'torrent',
  // Archives and NZBs are fetched over HTTP; a player frame is a web page.
  rar: 'http',
  zip: 'http',
  zip7: 'http',
  tgz: 'http',
  tar: 'http',
  nzb: 'http',
  playerFrame: 'external',
  external: 'external',
};

/** Variants the engine module can't prepare yet (phase-1 open question). */
const UNSUPPORTED: ReadonlySet<StreamSourceVariant> = new Set([
  'rar',
  'zip',
  'zip7',
  'tgz',
  'tar',
  'nzb',
  'playerFrame',
]);

/** Source fields per variant: what identifies the stream, and nothing else. */
const SOURCE_FIELDS: Record<StreamSourceVariant, readonly string[]> = {
  url: ['url'],
  youTube: ['ytId'],
  torrent: ['infoHash', 'fileIdx'],
  rar: ['rarUrls', 'fileIdx', 'fileMustInclude'],
  zip: ['zipUrls', 'fileIdx', 'fileMustInclude'],
  zip7: ['7zipUrls', 'fileIdx', 'fileMustInclude'],
  tgz: ['tgzUrls', 'fileIdx', 'fileMustInclude'],
  tar: ['tarUrls', 'fileIdx', 'fileMustInclude'],
  nzb: ['nzbUrl', 'nzbUrls', 'servers'],
  playerFrame: ['playerFrameUrl'],
  external: ['externalUrl', 'androidTvUrl', 'tizenUrl', 'webosUrl'],
};

/**
 * `behaviorHints.proxyHeaders` as stable `[direction, name, value]` triples
 * (header names lowercased, sorted), or `undefined` when there are none. The
 * same URL with other headers can return other content, so they are part of a
 * stream's identity; a stream without them keeps the key it always had.
 */
function proxyHeaderIdentity(stream: Record<string, unknown>): string[][] | undefined {
  const hints = stream.behaviorHints;
  const proxy =
    typeof hints === 'object' && hints !== null
      ? (hints as Record<string, unknown>).proxyHeaders
      : undefined;
  if (typeof proxy !== 'object' || proxy === null) return undefined;
  const triples: string[][] = [];
  for (const direction of ['request', 'response'] as const) {
    const headers = (proxy as Record<string, unknown>)[direction];
    if (typeof headers !== 'object' || headers === null) continue;
    for (const [name, value] of Object.entries(headers)) {
      triples.push([direction, name.toLowerCase(), String(value)]);
    }
  }
  if (triples.length === 0) return undefined;
  return triples.sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
}

/**
 * A stable key for a stream: SHA-256 over the addon id, the source variant, its
 * source fields and its `proxyHeaders`, base64url, 32 characters (192 bits).
 * URLs and headers can carry debrid tokens, so they are only ever hashed, never
 * embedded.
 */
export function candidateKey(
  addonId: string,
  variant: StreamSourceVariant,
  stream: Record<string, unknown>,
): string {
  const fields = SOURCE_FIELDS[variant].map((field) => [field, stream[field] ?? null]);
  const headers = proxyHeaderIdentity(stream);
  const material = JSON.stringify(
    headers === undefined ? [addonId, variant, fields] : [addonId, variant, fields, headers],
  );
  return createHash('sha256').update(material).digest('base64url').slice(0, 32);
}

/**
 * Builds the candidate for a stream that passed `StreamSchema`. Returns
 * `undefined` for a stream with no valid source (it can't be played or keyed).
 */
export function toCandidate(
  addon: CandidateAddon,
  stream: Stream,
  options: CandidateOptions = {},
): SourceCandidate | undefined {
  const variant = streamSourceVariant(stream);
  if (variant === undefined) return undefined;

  let kind = KIND_BY_VARIANT[variant];
  if (addon.engineId !== undefined && kind !== 'external') kind = 'engine-local';
  else if (kind === 'http' && (options.type === 'tv' || options.type === 'channel')) kind = 'live';

  const unplayableReason = UNSUPPORTED.has(variant)
    ? ('unsupported' as const)
    : variant === 'external'
      ? ('external' as const)
      : undefined;

  const candidate: SourceCandidate = {
    key: candidateKey(addon.id, variant, stream),
    addonId: addon.id,
    addonName: addon.name,
    kind,
    name: stream.name ?? '',
    title: stream.description ?? stream.title ?? stream.behaviorHints.filename ?? '',
    parsed: parseStream(stream),
    score: 0,
    playable: unplayableReason === undefined,
  };
  if (addon.engineId !== undefined) candidate.requiresEngine = addon.engineId;
  if (unplayableReason !== undefined) candidate.unplayableReason = unplayableReason;
  const bingeGroup = bingeGroupOf(stream);
  if (bingeGroup !== undefined) candidate.bingeGroup = bingeGroup;
  return candidate;
}

/**
 * The stream's `behaviorHints.bingeGroup` (stremio-core `is_binge_match`): an
 * addon-chosen label, not a secret. Empty or overlong values are dropped.
 */
export function bingeGroupOf(stream: Stream): string | undefined {
  // Read defensively: a session's stored stream may predate parsing defaults.
  const hints = (stream as { behaviorHints?: { bingeGroup?: unknown } }).behaviorHints;
  const group = hints?.bingeGroup;
  if (typeof group !== 'string' || group === '' || group.length > MAX_BINGE_GROUP_LENGTH) {
    return undefined;
  }
  return group;
}

/** Candidates for one addon's streams, in the addon's order, with the raw streams kept alongside. */
export function toCandidates(
  addon: CandidateAddon,
  streams: readonly Stream[],
  options: CandidateOptions = {},
): CandidateWithStream[] {
  const out: CandidateWithStream[] = [];
  for (const stream of streams) {
    const candidate = toCandidate(addon, stream, options);
    if (candidate !== undefined) out.push({ candidate, stream });
  }
  return out;
}
