import { describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { loadConfig } from '../src/config.ts';
import { createApp, openApiDocument } from '../src/http/app.ts';
import { devCsp, devMediaOrigin } from '../src/http/routes/dev.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

async function appFor(
  nodeEnv: 'development' | 'production' | 'test',
  env: Record<string, string> = {},
) {
  const db = await migratedMemoryDb();
  const { logger } = memoryLogger();
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: nodeEnv, ...env });
  const addons = new AddonService({ config, db, logger, clock });
  const streams = new StreamStore({ clock });
  const subtitles = new SubtitleService({ addons, clock, logger });
  return createApp({
    config,
    db,
    logger,
    clock,
    addons,
    streams,
    subtitles,
    metrics: new MetricsRegistry(),
  });
}

/** Every `/dev` path, with the Content-Type it's served with. */
const PATHS: [string, string][] = [
  ['/dev', 'text/html'],
  ['/dev/dev.js', 'text/javascript'],
  ['/dev/dev.css', 'text/css'],
  ['/dev/hls.mjs', 'text/javascript'],
  ['/dev/hls.mjs.map', 'application/json'],
  ['/dev/config.json', 'application/json'],
];

/** `app.request('/dev')` reaches the API as http://localhost; media is on the default MULTITAP_MEDIA_PORT. */
const LOCAL_MEDIA_ORIGIN = 'http://localhost:8081';

/** Status, headers (less the request id) and body, for comparing responses. */
async function snapshot(res: Response) {
  const headers = Object.fromEntries(
    [...res.headers].filter(([name]) => name.toLowerCase() !== 'x-request-id'),
  );
  return { status: res.status, headers, body: await res.text() };
}

describe('/dev in development', () => {
  it('serves the page, its assets and hls.js with a CSP for itself and the media origin', async () => {
    const app = await appFor('development');
    for (const [path, type] of PATHS) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type')).toContain(type);
      expect(res.headers.get('Content-Security-Policy')).toBe(devCsp(LOCAL_MEDIA_ORIGIN));
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  it('has a CSP that allows only the page itself, plus the media origin for media', () => {
    const csp = devCsp(LOCAL_MEDIA_ORIGIN);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain(`connect-src 'self' ${LOCAL_MEDIA_ORIGIN};`);
    expect(csp).toContain(`media-src 'self' blob: ${LOCAL_MEDIA_ORIGIN};`);
    expect(csp).not.toMatch(/unsafe|\*|worker-src/);
    // The media origin is in connect-src and media-src, nowhere else.
    expect(csp.split(LOCAL_MEDIA_ORIGIN)).toHaveLength(3);
    expect(devCsp(null)).not.toMatch(/https?:/);
  });

  it('loads its script and stylesheet from /dev, with no inline code', async () => {
    const app = await appFor('development');
    const html = await (await app.request('/dev')).text();
    expect(html).toContain('<script type="module" src="/dev/dev.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/dev/dev.css" />');
    expect(html).not.toMatch(/<script>|<style|\son[a-z]+=|style=/);
  });

  it('serves hls.js from node_modules as an ES module, not from a CDN', async () => {
    const app = await appFor('development');
    const hls = await (await app.request('/dev/hls.mjs')).text();
    expect(hls).toMatch(/export \{[^}]*\bHls as default\b/);
    const html = await (await app.request('/dev')).text();
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    const js = await (await app.request('/dev/dev.js')).text();
    expect(js).toContain("import('/dev/hls.mjs')");
    expect(js).not.toMatch(/import\(['"]https?:/);
  });

  it('marks both players crossorigin', async () => {
    const app = await appFor('development');
    const html = await (await app.request('/dev')).text();
    const videos = html.match(/<video[^>]*>/g) ?? [];
    expect(videos).toHaveLength(2);
    for (const video of videos) expect(video).toContain('crossorigin="anonymous"');
  });

  it('needs no key to load', async () => {
    const app = await appFor('development');
    expect((await app.request('/dev', { headers: { Authorization: 'Bearer nope' } })).status).toBe(
      200,
    );
  });

  it('tells the page the media origin and the CORS origins', async () => {
    const app = await appFor('development', { MULTITAP_CORS_ORIGINS: 'http://localhost:8080' });
    const res = await app.request('/dev/config.json');
    expect(await res.json()).toEqual({
      mediaOrigin: LOCAL_MEDIA_ORIGIN,
      mediaPublicBase: false,
      corsOrigins: ['http://localhost:8080'],
    });
  });

  it('takes the media origin from MULTITAP_MEDIA_PUBLIC_BASE when set', async () => {
    const app = await appFor('development', {
      MULTITAP_MEDIA_PUBLIC_BASE: 'https://media.example.org/core/',
    });
    const res = await app.request('/dev');
    expect(res.headers.get('Content-Security-Policy')).toBe(devCsp('https://media.example.org'));
    const config = (await (await app.request('/dev/config.json')).json()) as {
      mediaOrigin: string;
      mediaPublicBase: boolean;
    };
    expect(config).toMatchObject({
      mediaOrigin: 'https://media.example.org',
      mediaPublicBase: true,
    });
  });

  it('derives the media origin from the request host, MULTITAP_MEDIA_PORT and TLS', () => {
    const plain = loadConfig({ NODE_ENV: 'development', MULTITAP_MEDIA_PORT: '9001' });
    expect(devMediaOrigin(plain, 'http://192.168.1.5:9000/dev')).toBe('http://192.168.1.5:9001');
    expect(devMediaOrigin(plain, 'http://[::1]:9000/dev')).toBe('http://[::1]:9001');
    const tls = loadConfig({
      NODE_ENV: 'development',
      MULTITAP_TLS_CERT_FILE: 'cert.pem',
      MULTITAP_TLS_KEY_FILE: 'key.pem',
    });
    expect(devMediaOrigin(tls, 'https://core.test:8080/dev')).toBe('https://core.test:8081');
    // A Host that could add to the CSP gets no media origin.
    expect(devMediaOrigin(plain, 'http://a;b/dev')).toBeNull();
  });
});

describe('/dev outside development', () => {
  it.each(['production', 'test'] as const)(
    'answers exactly like an unknown route in %s, hls.js included',
    async (nodeEnv) => {
      const app = await appFor(nodeEnv);
      const unknown = await snapshot(await app.request('/no-such-route'));
      const unauthenticated = await snapshot(await app.request('/v1/catalogs'));
      expect(unknown.status).toBe(404);
      expect(unauthenticated).toEqual(unknown);
      for (const [path] of PATHS) {
        const res = await app.request(path);
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
        expect(await snapshot(res), path).toEqual(unknown);
      }
    },
  );
});

describe('/dev and the OpenAPI document', () => {
  it('is not declared', () => {
    const paths = Object.keys(openApiDocument().paths ?? {});
    expect(paths.filter((path) => path.startsWith('/dev'))).toEqual([]);
  });
});
