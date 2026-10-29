/**
 * The throwaway `/dev` page (phase 1 step 10, player in phase 2 step 10): a
 * static HTML page for walking catalogs → meta → the source list against
 * Multitap's own `/v1` API by hand, then playing a source through a playback
 * session and media tokens with hls.js. A developer tool, not a client.
 *
 * Served only when `NODE_ENV=development`. In any other environment every
 * `/dev` path goes to the app's not-found handler, so it answers exactly like
 * an unknown route (and like an unauthenticated one, okf:architecture/core-api-keys-security). The page needs no
 * key to load; it asks for one and sends it as a Bearer token.
 *
 * hls.js is a devDependency of @multitap/core, served from `node_modules` at
 * `/dev/hls.mjs` (no CDN). No module imports it; it is only read as a file in
 * development, so the production image (no devDependencies) never needs it.
 *
 * The page is on the API port and media is on the media port, so playback is
 * cross-origin by construction: the CSP allows the media origin, and the media
 * listener's CORS (`MULTITAP_CORS_ORIGINS`) must allow the page's origin.
 *
 * Plain Hono routes, not `openapi()`, so the page stays out of the OpenAPI
 * document and the contract tests.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../../config.ts';
import type { AppDeps, AppEnv } from '../types.ts';

/**
 * The page's static files, in packages/core/dev. Found relative to this module,
 * which is at src/http/routes in dev and dist/http/routes in the image.
 */
export const DEV_DIR = path.resolve(import.meta.dirname, '../../../dev');

/** hls.js's builds, in @multitap/core's own node_modules (pnpm links devDependencies there). */
export const HLS_DIR = path.resolve(import.meta.dirname, '../../../node_modules/hls.js/dist');

/** A hostname as it can appear in an origin: a DNS name, IPv4, or a bracketed IPv6 literal. */
const HOSTNAME = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i;

/**
 * The origin players load media from: `MULTITAP_MEDIA_PUBLIC_BASE`'s origin when set,
 * else `MULTITAP_MEDIA_PORT` on the host this request reached the API by (http, or
 * https with built-in TLS). `null` when that host isn't a plain hostname, so a
 * forged `Host` can't add to the CSP.
 */
export function devMediaOrigin(config: Config, requestUrl: string): string | null {
  if (config.media.publicBase !== null) return new URL(config.media.publicBase).origin;
  const { hostname } = new URL(requestUrl);
  if (!HOSTNAME.test(hostname)) return null;
  const scheme = config.tls === null ? 'http' : 'https';
  return `${scheme}://${hostname}:${String(config.media.port)}`;
}

/**
 * Same-origin, plus the media origin for playlists, segments and subtitle
 * tracks. `blob:` media is hls.js's MediaSource; the page turns its worker off,
 * so there is no `worker-src`. No inline script or style, no third-party
 * anything.
 */
export function devCsp(mediaOrigin: string | null): string {
  const media = mediaOrigin === null ? '' : ` ${mediaOrigin}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self'${media}`,
    `media-src 'self' blob:${media}`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const JS = 'text/javascript; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

const FILES = {
  '/dev': { dir: DEV_DIR, file: 'index.html', type: 'text/html; charset=utf-8' },
  '/dev/dev.js': { dir: DEV_DIR, file: 'dev.js', type: JS },
  '/dev/dev.css': { dir: DEV_DIR, file: 'dev.css', type: 'text/css; charset=utf-8' },
  '/dev/hls.mjs': { dir: HLS_DIR, file: 'hls.mjs', type: JS },
  '/dev/hls.mjs.map': { dir: HLS_DIR, file: 'hls.mjs.map', type: JSON_TYPE },
} as const;

export function registerDevRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const headers = (url: string, type: string) => ({
    'Content-Type': type,
    'Content-Security-Policy': devCsp(devMediaOrigin(deps.config, url)),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });

  for (const [route, { dir, file, type }] of Object.entries(FILES)) {
    app.get(route, (c) => {
      // Checked per request, not at registration: the app is also built without
      // deps just to read its OpenAPI document. Files are read per request too,
      // so edits to the page show on reload.
      if (deps.config.nodeEnv !== 'development') return c.notFound();
      let body: string;
      try {
        body = readFileSync(path.join(dir, file), 'utf8');
      } catch {
        // hls.js is missing after an install without devDependencies.
        return c.notFound();
      }
      return c.body(body, 200, headers(c.req.url, type));
    });
  }

  // What the page can't know by itself: where media is, and whether CORS lets
  // its origin load it.
  app.get('/dev/config.json', (c) => {
    if (deps.config.nodeEnv !== 'development') return c.notFound();
    const { config } = deps;
    const body = {
      mediaOrigin: devMediaOrigin(config, c.req.url),
      mediaPublicBase: config.media.publicBase !== null,
      corsOrigins: config.corsOrigins,
    };
    return c.body(JSON.stringify(body), 200, headers(c.req.url, JSON_TYPE));
  });
}
