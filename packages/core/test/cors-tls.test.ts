import { writeFileSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.ts';
import { createMediaApp } from '../src/gateway/app.ts';
import { isLoopbackAddress, listen, onReloadSignal, type Listener } from '../src/http/listen.ts';
import { startMultitap, type RunningMultitap } from '../src/index.ts';
import { memoryLogger, tempDir } from './helpers.ts';
import { selfSignedCertificate, type TestCertificate } from './tls-cert.ts';

const ALLOWED = 'https://app.example.org';
const OTHER = 'https://evil.example.net';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function configFor(env: Record<string, string>): Config {
  const dir = tempDir();
  cleanups.push(dir.cleanup);
  const loaded = loadConfig({ NODE_ENV: 'test', MULTITAP_DATA_DIR: dir.dir, ...env });
  return { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } };
}

async function start(env: Record<string, string>) {
  const log = memoryLogger();
  const multitap: RunningMultitap = await startMultitap(configFor(env), log.logger);
  cleanups.push(() => multitap.close());
  return {
    multitap,
    log,
    api: `http://127.0.0.1:${String(multitap.port)}`,
    media: `http://127.0.0.1:${String(multitap.mediaPort)}`,
  };
}

/** Whether startup warned that the API listener is exposed over plain HTTP. */
const warnedPlainHttp = (lines: Record<string, unknown>[]) =>
  lines.some((line) => line.level === 40 && String(line.msg).includes('over plain HTTP'));

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));

describe('CORS on the API listener', () => {
  it('answers an allowed origin with that origin and Vary: Origin, never credentials', async () => {
    const { api } = await start({ MULTITAP_CORS_ORIGINS: `${ALLOWED},https://other.example.org` });
    const res = await fetch(`${api}/healthz`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('preflights with the documented methods and the API headers, without a key', async () => {
    const { api } = await start({ MULTITAP_CORS_ORIGINS: ALLOWED });
    const res = await fetch(`${api}/v1/admin/api-keys`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,HEAD,POST');
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'Authorization,Content-Type,Last-Event-ID',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
  });

  it('keeps auth and 404s for an allowed origin', async () => {
    const { api } = await start({ MULTITAP_CORS_ORIGINS: ALLOWED });
    const res = await fetch(`${api}/v1/admin/api-keys`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    // A preflight for an undocumented path gets no CORS headers.
    const unknown = await fetch(`${api}/dev`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    expect(unknown.status).toBe(404);
    expect(corsHeaders(unknown)).toEqual([]);
  });

  it('sends no CORS headers to a disallowed or absent origin', async () => {
    const { api } = await start({ MULTITAP_CORS_ORIGINS: ALLOWED });
    for (const headers of [{ Origin: OTHER }, {}]) {
      const res = await fetch(`${api}/healthz`, { headers });
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual([]);
      expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
    }
    const preflight = await fetch(`${api}/healthz`, {
      method: 'OPTIONS',
      headers: { Origin: OTHER, 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(405);
    expect(corsHeaders(preflight)).toEqual([]);
  });

  it('sends no CORS headers at all when MULTITAP_CORS_ORIGINS is empty', async () => {
    const { api } = await start({});
    const res = await fetch(`${api}/healthz`, { headers: { Origin: ALLOWED } });
    expect(corsHeaders(res)).toEqual([]);
    expect(res.headers.get('vary')).toBeNull();
  });
});

describe('the media listener', () => {
  it('serves only /media and 404s everything else', async () => {
    const { media } = await start({});
    for (const path of ['/healthz', '/v1/admin/api-keys', '/openapi.json', `/media/${TOKEN}/x`]) {
      expect((await fetch(`${media}${path}`)).status).toBe(404);
    }
  });

  it('answers allowed origins with CORS, exposing Content-Length and Content-Range', async () => {
    const { media } = await start({ MULTITAP_CORS_ORIGINS: ALLOWED });
    const res = await fetch(`${media}/media/${TOKEN}/master.m3u8`, {
      headers: { Origin: ALLOWED },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-expose-headers')).toBe('Content-Length,Content-Range');
    expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();

    const preflight = await fetch(`${media}/media/${TOKEN}/seg-1.ts`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET,HEAD');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Range');
  });

  it('sends no CORS headers to disallowed or absent origins, or outside /media', async () => {
    const { media } = await start({ MULTITAP_CORS_ORIGINS: ALLOWED });
    for (const headers of [{ Origin: OTHER }, {}]) {
      const res = await fetch(`${media}/media/${TOKEN}/master.m3u8`, { headers });
      expect(corsHeaders(res)).toEqual([]);
    }
    const outside = await fetch(`${media}/healthz`, { headers: { Origin: ALLOWED } });
    expect(outside.status).toBe(404);
    expect(corsHeaders(outside)).toEqual([]);
  });

  it('can be built on its own', async () => {
    const app = createMediaApp({
      config: configFor({ MULTITAP_CORS_ORIGINS: ALLOWED }),
      logger: memoryLogger().logger,
    });
    const res = await app.request(`/media/${TOKEN}/master.m3u8`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });
});

it('warns when CORS is on and MULTITAP_MEDIA_PUBLIC_BASE is unset', async () => {
  const warned = (lines: Record<string, unknown>[]) =>
    lines.some(
      (line) => line.level === 40 && String(line.msg).includes('MULTITAP_MEDIA_PUBLIC_BASE'),
    );
  expect(warned((await start({ MULTITAP_CORS_ORIGINS: ALLOWED })).log.lines())).toBe(true);
  const withBase = await start({
    MULTITAP_CORS_ORIGINS: ALLOWED,
    MULTITAP_MEDIA_PUBLIC_BASE: 'https://media.example.org',
  });
  expect(warned(withBase.log.lines())).toBe(false);
  expect(warned((await start({})).log.lines())).toBe(false);
});

describe('bind addresses (MULTITAP_API_BIND, MULTITAP_MEDIA_BIND)', () => {
  const fetchOk = () => new Response('ok');
  const addressOf = (listener: Listener) => (listener.server.address() as AddressInfo).address;

  it('binds a listener to the given address, over HTTP and HTTPS, and to all interfaces by default', async () => {
    const plain = await listen(fetchOk, 0, null, '127.0.0.1');
    cleanups.push(() => plain.close());
    expect(addressOf(plain)).toBe('127.0.0.1');
    expect(await (await fetch(`http://127.0.0.1:${String(plain.port)}/`)).text()).toBe('ok');

    const cert = selfSignedCertificate();
    const secure = await listen(
      fetchOk,
      0,
      { cert: Buffer.from(cert.cert), key: Buffer.from(cert.key) },
      '127.0.0.1',
    );
    cleanups.push(() => secure.close());
    expect(addressOf(secure)).toBe('127.0.0.1');

    const all = await listen(fetchOk, 0, null);
    cleanups.push(() => all.close());
    expect(['::', '0.0.0.0']).toContain(addressOf(all));
  });

  it('startMultitap applies them to both listeners and logs them', async () => {
    const { multitap, log, api, media } = await start({
      MULTITAP_API_BIND: '127.0.0.1',
      MULTITAP_MEDIA_BIND: '127.0.0.1',
    });
    expect((await fetch(`${api}/healthz`)).status).toBe(200);
    expect((await fetch(`${media}/healthz`)).status).toBe(404);
    expect(multitap.port).toBeGreaterThan(0);
    expect(
      log
        .lines()
        .some(
          (line) =>
            line.msg === 'Multitap listening' &&
            line.apiBind === '127.0.0.1' &&
            line.mediaBind === '127.0.0.1',
        ),
    ).toBe(true);
  });

  // Adversarial review finding sec-access-api-listener-public-default: the default
  // stays every interface (a container needs it), but Multitap says it's exposed.
  it('warns when the API listener is on a non-loopback address over plain HTTP', async () => {
    expect(warnedPlainHttp((await start({})).log.lines())).toBe(true);
    expect(warnedPlainHttp((await start({ MULTITAP_API_BIND: '0.0.0.0' })).log.lines())).toBe(true);
    expect(warnedPlainHttp((await start({ MULTITAP_API_BIND: '127.0.0.1' })).log.lines())).toBe(
      false,
    );
    // The media listener is meant to be public: binding only the API to loopback is enough.
    expect(
      warnedPlainHttp(
        (
          await start({ MULTITAP_API_BIND: '127.0.0.1', MULTITAP_MEDIA_BIND: '0.0.0.0' })
        ).log.lines(),
      ),
    ).toBe(false);
  });

  it('tells loopback addresses from the rest', () => {
    for (const address of [
      '127.0.0.1',
      '127.0.1.1',
      '::1',
      '::ffff:127.0.0.1',
      '::FFFF:127.0.0.2',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
    for (const address of [
      '0.0.0.0',
      '::',
      '192.0.2.10',
      '198.51.100.7',
      '::ffff:192.0.2.1',
      'fe80::1',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
  });

  it('fails startup when the address is not on this host', async () => {
    // TEST-NET-1 (RFC 5737): never a local address.
    await expect(
      startMultitap(configFor({ MULTITAP_API_BIND: '192.0.2.1' }), memoryLogger().logger),
    ).rejects.toThrow();
  });
});

describe('built-in TLS', () => {
  function tlsFiles(first: TestCertificate) {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const certFile = join(dir.dir, 'cert.pem');
    const keyFile = join(dir.dir, 'key.pem');
    const write = (pair: { cert: string; key: string }) => {
      writeFileSync(certFile, pair.cert);
      writeFileSync(keyFile, pair.key);
    };
    write(first);
    return { env: { MULTITAP_TLS_CERT_FILE: certFile, MULTITAP_TLS_KEY_FILE: keyFile }, write };
  }

  /** A fresh connection's status and the certificate it was served, trusting `ca`. */
  function get(port: number, path: string, ca: string) {
    return new Promise<{ status: number; fingerprint: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          ca,
          agent: false,
          servername: 'localhost',
          // The client closes first: a server that closes right after its
          // response can reset the connection (Windows discards unread data on
          // RST) before a loaded client has read the response.
          headers: { Connection: 'keep-alive' },
        },
        (res) => {
          const socket = res.socket;
          const fingerprint = (
            socket as unknown as { getPeerCertificate(): { fingerprint256: string } }
          ).getPeerCertificate().fingerprint256;
          res.resume();
          res.on('end', () => {
            socket.destroy();
            resolve({ status: res.statusCode ?? 0, fingerprint });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const fingerprint = (cert: string) => new X509Certificate(cert).fingerprint256;

  it('serves both listeners over HTTPS with a self-signed certificate', async () => {
    const first = selfSignedCertificate();
    const { env } = tlsFiles(first);
    const { multitap, log } = await start(env);
    const api = await get(multitap.port, '/healthz', first.cert);
    expect(api).toEqual({ status: 200, fingerprint: fingerprint(first.cert) });
    const media = await get(multitap.mediaPort, '/healthz', first.cert);
    expect(media).toEqual({ status: 404, fingerprint: fingerprint(first.cert) });
    // On every interface, but keys don't travel in cleartext.
    expect(warnedPlainHttp(log.lines())).toBe(false);
  });

  it('reloads the files for new connections, and keeps the old pair when the reload fails', async () => {
    const first = selfSignedCertificate();
    const second = selfSignedCertificate();
    const { env, write } = tlsFiles(first);
    const { multitap, log } = await start(env);

    // A broken pair (key doesn't match): the old certificate stays.
    write({ cert: second.cert, key: first.key });
    expect(multitap.reloadTls()).toBe(false);
    expect(
      log
        .lines()
        .some((line) => line.level === 40 && String(line.msg).includes('TLS reload failed')),
    ).toBe(true);
    expect((await get(multitap.port, '/healthz', first.cert)).fingerprint).toBe(
      fingerprint(first.cert),
    );

    write(second);
    expect(multitap.reloadTls()).toBe(true);
    for (const port of [multitap.port, multitap.mediaPort]) {
      expect((await get(port, '/healthz', second.cert)).fingerprint).toBe(fingerprint(second.cert));
    }
  });

  it.skipIf(process.platform === 'win32')('reloads on SIGHUP', async () => {
    const first = selfSignedCertificate();
    const second = selfSignedCertificate();
    const { env, write } = tlsFiles(first);
    const { multitap } = await start(env);
    let reloaded!: () => void;
    const done = new Promise<void>((resolve) => {
      reloaded = resolve;
    });
    cleanups.push(
      onReloadSignal(() => {
        multitap.reloadTls();
        reloaded();
      }),
    );
    write(second);
    process.kill(process.pid, 'SIGHUP');
    await done;
    expect((await get(multitap.port, '/healthz', second.cert)).fingerprint).toBe(
      fingerprint(second.cert),
    );
  });

  it('fails startup when the files are unusable', async () => {
    const first = selfSignedCertificate();
    const { env } = tlsFiles({ cert: first.cert, key: selfSignedCertificate().key });
    await expect(startMultitap(configFor(env), memoryLogger().logger)).rejects.toThrow();
  });
});
