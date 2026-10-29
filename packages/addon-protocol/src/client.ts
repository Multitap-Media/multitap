/**
 * The addon HTTP client: stremio-core's `AddonHTTPTransport` on `fetch`.
 *
 * - JSON only, over http(s). The legacy transport (`/stremio/v1`) isn't
 *   supported: a transport URL must end in `/manifest.json`.
 * - Every request has a timeout and a response size cap; the body is streamed
 *   and the request aborted as soon as it passes the cap.
 * - The client never logs. Errors carry only the addon's host, never its URL,
 *   because addon URLs can hold secrets.
 * - Redirects go through the private-host guard
 *   (okf:architecture/addon-private-host-guard): the transport URL is the
 *   operator's choice, but where it redirects is the addon's, so every hop
 *   after the first must stay in public address space unless the guard's
 *   allowlist names it. A refused hop fails as `network` (`ERR_PRIVATE_HOST`).
 */
import {
  AddonAbortedError,
  AddonHttpStatusError,
  AddonInvalidJsonError,
  AddonInvalidUrlError,
  AddonNetworkError,
  AddonResponseTooLargeError,
  AddonTimeoutError,
  AddonUnsupportedTransportError,
  AddonValidationError,
} from './errors.ts';
import { ManifestSchema, type Manifest } from './manifest.ts';
import { defaultPrivateHostGuard, type PrivateHostGuard } from './private-hosts.ts';
import { buildResourceUrl, isManifestUrl, type ResourcePathInput } from './request.ts';
import { parseResourceResponse, type ParsedResourceResponse } from './response.ts';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface AddonRequestOptions {
  /** Aborts the request (reported as `AddonAbortedError`). */
  signal?: AbortSignal;
  /** Covers the whole request, body included. Default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Largest accepted response body, in bytes. Default `DEFAULT_MAX_BYTES`. */
  maxBytes?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** A `fetch` implementation, for tests. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Guards the redirect hops. Default: no allowlist (`defaultPrivateHostGuard`). */
  guard?: PrivateHostGuard;
}

/**
 * Parses and checks an addon transport URL: it must be http(s) and its path must
 * end in `/manifest.json`.
 */
export function parseTransportUrl(transportUrl: string | URL): URL {
  let url: URL;
  try {
    url = new URL(transportUrl);
  } catch {
    // The parser's error carries the input, so it's replaced rather than wrapped.
    throw new AddonInvalidUrlError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AddonInvalidUrlError(url.host || undefined);
  }
  if (!isManifestUrl(url)) throw new AddonUnsupportedTransportError(url.host);
  return url;
}

function systemErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = e.cause;
  }
  return undefined;
}

async function readBody(response: Response, host: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AddonResponseTooLargeError(host, maxBytes);
  }
  if (response.body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AddonResponseTooLargeError(host, maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** GETs a URL and returns its parsed JSON body. */
async function fetchJson(url: URL, options: AddonRequestOptions): Promise<unknown> {
  const host = url.host;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const guard = options.guard ?? defaultPrivateHostGuard;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw new AddonAbortedError(host);

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const abortError = () =>
    callerSignal?.aborted ? new AddonAbortedError(host) : new AddonTimeoutError(host, timeoutMs);

  let body: Uint8Array;
  try {
    const response = await guard.fetch(
      url,
      { signal, redirect: 'follow', headers: { accept: 'application/json', ...options.headers } },
      options.fetch === undefined
        ? { trustFirstHop: true }
        : { trustFirstHop: true, fetch: options.fetch },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AddonHttpStatusError(host, response.status);
    }
    body = await readBody(response, host, maxBytes);
  } catch (error) {
    if (error instanceof AddonHttpStatusError || error instanceof AddonResponseTooLargeError) {
      throw error;
    }
    if (signal.aborted) throw abortError();
    throw new AddonNetworkError(host, systemErrorCode(error));
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new AddonInvalidJsonError(host);
  }
}

/** Fetches and validates an addon's manifest from its transport URL. */
export async function fetchManifest(
  transportUrl: string | URL,
  options: AddonRequestOptions = {},
): Promise<Manifest> {
  const url = parseTransportUrl(transportUrl);
  const body = await fetchJson(url, options);
  const result = ManifestSchema.safeParse(body);
  if (!result.success) {
    throw new AddonValidationError(url.host, 'invalid manifest', result.error.issues);
  }
  return result.data;
}

/**
 * Fetches a resource from an addon: `GET {base}/{resource}/{type}/{id}[/{extra}].json`,
 * where `{base}` is the transport URL without its trailing `/manifest.json`.
 *
 * List responses keep their valid items and report the others in `dropped`; the
 * call only throws when the response as a whole is unusable. Callers check
 * `response.type` against the resource they asked for.
 */
export async function fetchResource(
  transportUrl: string | URL,
  path: ResourcePathInput,
  options: AddonRequestOptions = {},
): Promise<ParsedResourceResponse> {
  const base = parseTransportUrl(transportUrl);
  const url = buildResourceUrl(base, path);
  // parseTransportUrl has already checked the suffix buildResourceUrl needs.
  if (url === undefined) throw new AddonUnsupportedTransportError(base.host);
  const body = await fetchJson(url, options);
  const result = parseResourceResponse(body);
  if (!result.success) {
    throw new AddonValidationError(url.host, result.message, result.issues);
  }
  return result.data;
}
