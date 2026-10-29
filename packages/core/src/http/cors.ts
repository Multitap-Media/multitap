import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/** How long browsers may cache a preflight answer, in seconds. */
export const PREFLIGHT_MAX_AGE = 600;

export interface AllowlistCorsOptions {
  /**
   * The methods a preflight for this request's path may use. `undefined` for a
   * path the listener doesn't serve: its preflight gets no CORS headers and
   * falls through to routing (a 404), so it reveals nothing.
   */
  allowMethods: (c: Context) => readonly string[] | undefined;
  allowHeaders: readonly string[];
  exposeHeaders?: readonly string[];
}

/**
 * CORS from an exact-origin allowlist (`MULTITAP_CORS_ORIGINS`, okf:architecture/core-deployment, okf:architecture/media-gateway-proxy), built on `hono/cors`.
 *
 * - An empty allowlist sends no CORS headers at all.
 * - An allowed `Origin` gets `Access-Control-Allow-Origin` with that origin and
 *   `Vary: Origin`; preflights get the methods and headers from `options`.
 * - Any other request (no `Origin`, or one not on the list) gets no CORS
 *   headers, only `Vary: Origin`, so a shared cache can't hand an allowed
 *   origin's response to another. Its preflight falls through to routing.
 * - Never `Access-Control-Allow-Credentials`: credentials are bearer keys and
 *   tokens, not cookies.
 */
export function allowlistCors(
  origins: readonly string[],
  options: AllowlistCorsOptions,
): MiddlewareHandler {
  if (origins.length === 0) {
    return async (_c, next) => {
      await next();
    };
  }
  const allowed = new Set(origins);
  const handler = cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: (_origin, c) => [...(options.allowMethods(c) ?? [])],
    allowHeaders: [...options.allowHeaders],
    exposeHeaders: [...(options.exposeHeaders ?? [])],
    maxAge: PREFLIGHT_MAX_AGE,
    credentials: false,
  });
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const isAllowed = origin !== undefined && allowed.has(origin);
    const servesPath = c.req.method !== 'OPTIONS' || options.allowMethods(c) !== undefined;
    if (isAllowed && servesPath) return handler(c, next);
    await next();
    c.header('Vary', 'Origin', { append: true });
  };
}
