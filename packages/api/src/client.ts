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
import createClient, { type Client } from 'openapi-fetch';
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

export function createMultitapClient(options: MultitapClientOptions): MultitapClient {
  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    headers: { Authorization: `Bearer ${options.apiKey}` },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
