/**
 * A typed client for Multitap's `/v1` API (okf:architecture/core-api-testing), generated from
 * openapi.json: `schema.d.ts` is written by `pnpm --filter @multitap/api
 * generate`, and openapi-fetch turns it into typed calls.
 *
 *   const multitap = createMultitapClient({ baseUrl: 'http://localhost:8080', apiKey });
 *   const { data, error } = await multitap.GET('/v1/streams/{type}/{videoId}', {
 *     params: { path: { type: 'movie', videoId: 'tt1375666' }, query: { sort: 'rank' } },
 *   });
 */
import createClient, { defaultPathSerializer, type Client } from 'openapi-fetch';
import type { components, operations, paths } from './schema.d.ts';

export type { components, operations, paths };

/** A typed openapi-fetch client for Multitap. */
export type MultitapClient = Client<paths>;

export interface MultitapClientOptions {
  /** Multitap's API origin, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** An API key; sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** A fetch to use instead of `globalThis.fetch` (tests, proxies). */
  fetch?: (request: Request) => Promise<Response>;
}

/**
 * Fills path parameters as openapi-fetch does, but refuses `.` and `..`:
 * `encodeURIComponent` leaves them as they are, and a URL path drops such a
 * segment (WHATWG URL), so the request would reach another route (e.g.
 * `DELETE /v1/sessions/{id}/tokens/..` is `DELETE /v1/sessions/{id}`).
 *
 * @throws {TypeError} for a `.` or `..` path parameter.
 */
function pathSerializer(pathname: string, pathParams: Record<string, unknown>): string {
  for (const [name, value] of Object.entries(pathParams)) {
    if (value === '.' || value === '..') {
      throw new TypeError(
        `Path parameter "${name}" is "${value}", which a URL path cannot carry (it would reach another route); no request was sent.`,
      );
    }
  }
  return defaultPathSerializer(pathname, pathParams);
}

/**
 * A client for Multitap at `baseUrl`. A path parameter that is `.` or `..`
 * throws a `TypeError` instead of sending a request to another route.
 */
export function createMultitapClient(options: MultitapClientOptions): MultitapClient {
  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    headers: { Authorization: `Bearer ${options.apiKey}` },
    pathSerializer,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
