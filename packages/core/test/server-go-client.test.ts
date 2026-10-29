/**
 * The `lan` transport against a real local HTTP server, and the typed
 * server-go client and fake engine against each other (phase 2 step 2, 8).
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanTransport, engineBaseUrl, lanDispatcher } from '../src/engines/lan-transport.ts';
import { createServerGoClient, engineSelfBase } from '../src/engines/server-go.ts';
import { ServerGoError } from '../src/engines/server-go-types.ts';
import { EngineTransportError } from '../src/engines/transport.ts';
import { FakeEngine } from './fakes/engine.ts';

const IH = '0123456789abcdef0123456789abcdef01234567';
const timeouts = { control: 2_000, prepare: 2_000, media: 2_000 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

/** A raw HTTP server recording request headers; `delayMs` holds the response headers back. */
async function rawServer(delayMs = 0) {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    req.resume();
    const respond = () => {
      if (req.url === '/redirect') {
        res.writeHead(307, { Location: 'https://elsewhere.example/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    };
    if (delayMs > 0) setTimeout(respond, delayMs).unref();
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return { address: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

describe('lan transport', () => {
  it('sends no Origin header, on GET and POST, even when asked to', async () => {
    const { address, seen } = await rawServer();
    const transport = createLanTransport({ id: 'home', address: `${address}/` });
    await (await transport.request('/a?x=1', { timeoutMs: 1_000 })).text();
    await (
      await transport.request('/b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: '{}',
        timeoutMs: 1_000,
      })
    ).text();
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['GET', '/a?x=1'],
      ['POST', '/b'],
    ]);
    expect(seen.every((r) => r.headers.origin === undefined)).toBe(true);
  });

  it('does not follow redirects', async () => {
    const { address } = await rawServer();
    const res = await createLanTransport({ id: 'home', address }).request('/redirect', {
      timeoutMs: 1_000,
    });
    expect(res.status).toBe(307);
  });

  it('times out waiting for headers, without the URL in the error', async () => {
    const { address } = await rawServer(1_000);
    const err = await createLanTransport({ id: 'home', address })
      .request('/slow?mediaURL=secret', { timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineTransportError);
    expect(err).toMatchObject({ code: 'timeout', engineId: 'home' });
    expect(JSON.stringify(err) + String(err)).not.toContain('secret');
  });

  it("reports the caller's abort as aborted", async () => {
    const { address } = await rawServer(1_000);
    const controller = new AbortController();
    const pending = createLanTransport({ id: 'home', address }).request('/slow', {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('a refused connection and a missing address are network errors', async () => {
    const { address } = await rawServer();
    const port = new URL(address).port;
    cleanups.splice(0).forEach((fn) => void fn());
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      createLanTransport({ id: 'home', address: `http://127.0.0.1:${port}` }).request('/', {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'network' });
    await expect(
      createLanTransport({ id: 'home', address: null }).request('/', { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'network', message: 'engine has no address' });
  });

  it('passes the connect-timeout dispatcher, shared per value, only when one is set', async () => {
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fakeFetch = ((_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(new Response('ok'));
    }) as typeof fetch;
    const address = 'http://engine.test:11470';
    await createLanTransport(
      { id: 'home', address },
      { fetch: fakeFetch, connectTimeoutMs: 3_000 },
    ).request('/', { timeoutMs: 1_000 });
    await createLanTransport({ id: 'home', address }, { fetch: fakeFetch }).request('/', {
      timeoutMs: 1_000,
    });
    expect(inits[0]?.dispatcher).toBe(lanDispatcher(3_000));
    expect(lanDispatcher(3_000)).not.toBe(lanDispatcher(2_000));
    expect(inits[1]).not.toHaveProperty('dispatcher');
  });

  it('with a connect timeout, normal requests are unaffected', async () => {
    const { address, seen } = await rawServer();
    const transport = createLanTransport({ id: 'home', address }, { connectTimeoutMs: 3_000 });
    const res = await transport.request('/a', { timeoutMs: 1_000 });
    expect(await res.text()).toBe('ok');
    expect(seen.map((r) => r.url)).toEqual(['/a']);
  });

  it('a connection that never completes fails as a network error after the connect timeout', async () => {
    // A TCP listener that never answers the TLS handshake: the connect phase
    // hangs as it does against a host that drops packets (the connect timeout
    // covers TCP and TLS), without leaving the machine.
    const sockets: Socket[] = [];
    const server = createTcpServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });
    const port = String((server.address() as AddressInfo).port);
    const started = performance.now();
    const err = await createLanTransport(
      { id: 'home', address: `https://127.0.0.1:${port}` },
      { connectTimeoutMs: 200 },
    )
      .request('/hlsv2/x/seg.ts?mediaURL=secret', { timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineTransportError);
    expect(err).toMatchObject({
      code: 'network',
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(JSON.stringify(err) + String(err)).not.toContain('secret');
    // undici's timers are coarse (about 1 s for short values), far below the 10 s budget.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('accepts only http(s) base addresses without credentials', () => {
    expect(engineBaseUrl('http://winbox.lan:11470/')).toBe('http://winbox.lan:11470');
    expect(() => engineBaseUrl('ftp://winbox.lan')).toThrow();
    expect(() => engineBaseUrl('http://u:p@winbox.lan')).toThrow();
  });
});

describe('server-go client against the fake engine', () => {
  function client(fake = new FakeEngine()) {
    return {
      fake,
      client: createServerGoClient({
        engineId: 'home',
        transport: fake.transport('home'),
        timeouts,
        selfBase: engineSelfBase('http://engine.test:11470'),
      }),
    };
  }

  it('creates a torrent and reads its stats', async () => {
    const { fake, client: c } = client(
      new FakeEngine({ torrents: { [IH]: { files: [{ name: 'a.mkv', length: 5 }], peers: 3 } } }),
    );
    expect(await c.torrentStats(IH, 0)).toBeUndefined();
    const stats = await c.createTorrent(IH.toUpperCase(), {
      sources: ['tracker:udp://t.example:1'],
      guessFileIdx: true,
    });
    expect(stats).toMatchObject({ infoHash: IH, peers: 3, guessedFileIdx: 0 });
    expect(fake.creates[0]?.body).toEqual({
      peerSearch: { sources: ['tracker:udp://t.example:1'] },
      guessFileIdx: true,
    });
    expect(await c.torrentStats(IH, 0)).toMatchObject({ streamLen: 5, streamProgress: 0.25 });
  });

  it('maps a metadata timeout to a ServerGoError with status 504', async () => {
    const { client: c } = client();
    await expect(c.createTorrent(IH, {})).rejects.toMatchObject({
      status: 504,
      endpoint: 'create',
    });
    await expect(c.createTorrent('nothex', {})).rejects.toThrow('invalid info hash');
  });

  it('parses probes and drops placeholder zeros', async () => {
    const { fake, client: c } = client();
    fake.setProbe('https://m.example/a.mkv', 'hdr-4k');
    expect(await c.probe('https://m.example/a.mkv')).toEqual({
      durationSec: 120,
      formatName: 'matroska,webm',
      streams: [
        {
          index: 0,
          track: 'video',
          codec: 'hevc',
          width: 3840,
          height: 2160,
          default: true,
          profile: 'Main 10',
          hdr: 'hdr10',
        },
        { index: 1, track: 'audio', codec: 'eac3', lang: 'eng', default: true, channels: 2 },
      ],
    });
    fake.setProbe('https://m.example/b.mkv', 'failing');
    await expect(c.probe('https://m.example/b.mkv')).rejects.toBeInstanceOf(ServerGoError);
  });

  it('master: mediaURL and overrides in the query; the fake validates like #25', async () => {
    const { fake, client: c } = client();
    const ok = await c.master({
      sid: 'S1',
      mediaURL: 'https://m.example/a.mkv?token=x&y=1',
      overrides: { maxHeight: 720, bitrate: 3_500_000, ttlSec: 3_600 },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('RESOLUTION=x720');
    expect(fake.masterRequests[0]).toMatchObject({
      mediaURL: 'https://m.example/a.mkv?token=x&y=1',
      overrides: { maxHeight: '720', bitrate: '3500000', ttl: '3600' },
      created: true,
    });
    expect(fake.sessions.get('S1')?.applied).toEqual({
      maxHeight: 720,
      bitrate: 3_500_000,
      ttlSec: 3_600,
    });
    for (const overrides of [{ maxHeight: 8 }, { bitrate: 50_000 }, { ttlSec: 30 }]) {
      const res = await c.master({ sid: 'S2', mediaURL: 'https://m.example/a.mkv', overrides });
      expect(res.status).toBe(400);
      await res.text();
    }
    expect(fake.sessions.has('S2')).toBe(false);
  });

  it('master on an existing session applies only the ttl', async () => {
    const { fake, client: c } = client();
    await (
      await c.master({
        sid: 'S1',
        mediaURL: 'https://m.example/a.mkv',
        overrides: { maxHeight: 720 },
      })
    ).text();
    await (
      await c.master({
        sid: 'S1',
        mediaURL: 'https://m.example/a.mkv',
        overrides: { maxHeight: 360, ttlSec: 120 },
      })
    ).text();
    expect(fake.sessions.get('S1')?.applied).toEqual({ maxHeight: 720, ttlSec: 120 });
    expect(fake.mastersFor('S1').map((m) => m.created)).toEqual([true, false]);
  });

  it('files: relative-URI playlists, segments with latency, 400-free 404s after eviction', async () => {
    const { fake, client: c } = client(new FakeEngine({ segmentLatencyMs: 20 }));
    await (await c.master({ sid: 'S1', mediaURL: 'https://m.example/a.mkv' })).text();
    const playlist = await (await c.file('S1', 'playlist.m3u8')).text();
    expect(playlist).toMatch(/^seg0\.ts$/m);
    expect(playlist).toContain('#EXT-X-ENDLIST');
    const seg = await c.file('S1', 'seg29.ts');
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBe(1880);
    expect((await c.file('S1', 'seg30.ts')).status).toBe(404);
    fake.evict('S1');
    expect((await c.file('S1', 'seg0.ts')).status).toBe(404);
    await (await c.master({ sid: 'S1', mediaURL: 'https://m.example/a.mkv' })).text();
    expect((await c.file('S1', 'seg0.ts')).status).toBe(200);
    expect(fake.fileRequestCount('S1', 'seg0.ts')).toBe(2);
    expect(fake.segmentsCompleted).toEqual(['S1/seg29.ts', 'S1/seg0.ts']);
  });

  it('a restart forgets every session', async () => {
    const { fake, client: c } = client();
    await (await c.master({ sid: 'S1', mediaURL: 'https://m.example/a.mkv' })).text();
    fake.restart();
    expect((await c.file('S1', 'playlist.m3u8')).status).toBe(404);
  });

  it('detects DELETE support once and deletes', async () => {
    const { fake, client: c } = client();
    await (await c.master({ sid: 'S1', mediaURL: 'https://m.example/a.mkv' })).text();
    expect(await c.supportsDelete()).toBe(true);
    expect(await c.deleteSession('S1')).toBe('deleted');
    expect(await c.deleteSession('S1')).toBe('not-found');
    expect(fake.requests.filter((r) => r.path.startsWith('/hlsv2/..'))).toHaveLength(1);
    c.resetCapabilities();
    await c.supportsDelete();
    expect(fake.requests.filter((r) => r.path.startsWith('/hlsv2/..'))).toHaveLength(2);
  });

  it('an engine without DELETE is detected and never sent a real delete', async () => {
    const { fake, client: c } = client(new FakeEngine({ supportsDelete: false }));
    expect(await c.deleteSession('S1')).toBe('unsupported');
    expect(fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/hlsv2/..capability-probe',
    ]);
  });

  it('does not cache a failed capability probe', async () => {
    const fake = new FakeEngine();
    const { client: c } = client(fake);
    fake.online = false;
    await expect(c.supportsDelete()).rejects.toBeInstanceOf(EngineTransportError);
    fake.online = true;
    expect(await c.supportsDelete()).toBe(true);
  });

  it('builds engine-local URLs from the address port', () => {
    const { client: c } = client();
    expect(engineSelfBase('http://winbox.lan:12000')).toBe('http://127.0.0.1:12000');
    expect(engineSelfBase(null)).toBe('http://127.0.0.1:11470');
    expect(c.torrentMediaURL(IH, 2)).toBe(`http://127.0.0.1:11470/${IH}/2`);
    expect(c.torrentMediaURL(IH, 2, [])).toBe(`http://127.0.0.1:11470/${IH}/2`);
    expect(
      c.torrentMediaURL(IH, 2, ['udp://t.example:1337/announce', 'http://t2.example/a?x=1']),
    ).toBe(
      `http://127.0.0.1:11470/${IH}/2?tr=udp%3A%2F%2Ft.example%3A1337%2Fannounce&tr=http%3A%2F%2Ft2.example%2Fa%3Fx%3D1`,
    );
    expect(c.youtubeMediaURL('a/b')).toBe('http://127.0.0.1:11470/yt/a%2Fb');
    const proxied = new URL(
      c.proxyStreamMediaURL({
        url: 'https://m.example/a.mkv?x=1',
        requestHeaders: { Referer: 'https://m.example/' },
        apiPassword: 'pw',
      }),
    );
    expect(proxied.pathname).toBe('/proxy/stream');
    expect(Buffer.from(proxied.searchParams.get('d') ?? '', 'base64url').toString()).toBe(
      'https://m.example/a.mkv?x=1',
    );
    expect(proxied.searchParams.get('h_Referer')).toBe('https://m.example/');
    expect(proxied.searchParams.get('api_password')).toBe('pw');
  });

  it('reads metrics, and the fake refuses any Origin like server-go', async () => {
    const { fake, client: c } = client();
    expect(await c.metrics()).toContain('stremio_hls_sessions 0');
    const res = await fake.transport().request('/metrics', {
      timeoutMs: 1_000,
      headers: { Origin: 'https://x.example' },
    });
    expect(res.status).toBe(403);
  });

  it('the fake also serves over real HTTP', async () => {
    const fake = new FakeEngine();
    const address = await fake.listen();
    cleanups.push(() => fake.close());
    const c = createServerGoClient({
      engineId: 'home',
      transport: createLanTransport({ id: 'home', address }),
      timeouts,
    });
    expect(await c.supportsDelete()).toBe(true);
    expect(await c.metrics()).toContain('stremio_hls_sessions');
  });
});
