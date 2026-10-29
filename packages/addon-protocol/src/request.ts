/**
 * Resource requests and their URL encoding. Ported from stremio-core's
 * `types/addon/request.rs`, `types/query_params_encode.rs` and the path building
 * in `addon_transport/http_transport/http_transport.rs`.
 */
import { z } from 'zod';
import { urlString } from './common.ts';

/** The suffix every addon transport URL must end in (`ADDON_MANIFEST_PATH`). */
export const ADDON_MANIFEST_PATH = '/manifest.json';

/**
 * One extra value, e.g. `{ name: 'search', value: 'Harry Potter' }`. stremio-core
 * serializes it as a `[name, value]` tuple; here it's an object.
 */
export const ExtraValueSchema = z.object({ name: z.string(), value: z.string() });
export type ExtraValue = z.infer<typeof ExtraValueSchema>;

/**
 * The resource path of an addon request:
 * `{resource}/{type}/{id}.json`, or `{resource}/{type}/{id}/{extra}.json` when
 * there are extra values.
 */
export const ResourcePathSchema = z.object({
  /** `catalog`, `meta`, `stream`, `subtitles`, `addon_catalog`, … */
  resource: z.string(),
  /** `movie`, `series`, `channel`, … */
  type: z.string(),
  id: z.string(),
  extra: z.array(ExtraValueSchema).default(() => []),
});
export type ResourcePath = z.output<typeof ResourcePathSchema>;
/** A resource path where `extra` may be left out. */
export interface ResourcePathInput {
  resource: string;
  type: string;
  id: string;
  extra?: readonly ExtraValue[];
}

/** A resource path against an addon's transport URL (its `…/manifest.json` URL). */
export const ResourceRequestSchema = z.object({
  base: urlString,
  path: ResourcePathSchema,
});
export type ResourceRequest = z.output<typeof ResourceRequestSchema>;

/**
 * `utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET)`. The set is every
 * non-alphanumeric byte except `- _ . ! ~ * ' ( )`, which is exactly what
 * `encodeURIComponent` leaves alone, with uppercase hex digits in both. Rust
 * strings can't hold lone surrogates, so they're replaced with U+FFFD first
 * (where `encodeURIComponent` would throw).
 */
export function encodeUriComponent(value: string): string {
  return encodeURIComponent(value.toWellFormed());
}

/**
 * `query_params_encode`: `name=value` pairs, each side percent-encoded,
 * joined with `&`, in the given order.
 */
export function encodeExtra(extra: readonly ExtraValue[]): string {
  return extra
    .map(({ name, value }) => `${encodeUriComponent(name)}=${encodeUriComponent(value)}`)
    .join('&');
}

/** The encoded path of a request: `/{resource}/{type}/{id}[/{extra}].json`. */
export function encodeResourcePath(path: ResourcePathInput): string {
  const head = [path.resource, path.type, path.id].map(encodeUriComponent).join('/');
  const extra = path.extra ?? [];
  return extra.length === 0 ? `/${head}.json` : `/${head}/${encodeExtra(extra)}.json`;
}

/** True when a transport URL's path ends in `/manifest.json`. */
export function isManifestUrl(url: URL): boolean {
  return url.pathname.endsWith(ADDON_MANIFEST_PATH);
}

/**
 * Builds a resource URL from an addon's transport URL, replacing the trailing
 * `/manifest.json` of its path with the encoded resource path. The query string
 * is kept (some addons carry configuration there); the fragment is dropped.
 *
 * Returns `undefined` if the transport URL's path doesn't end in `/manifest.json`.
 */
export function buildResourceUrl(transportUrl: URL, path: ResourcePathInput): URL | undefined {
  if (!isManifestUrl(transportUrl)) return undefined;
  const url = new URL(transportUrl.href);
  url.pathname = url.pathname.slice(0, -ADDON_MANIFEST_PATH.length) + encodeResourcePath(path);
  url.hash = '';
  return url;
}
