// The addon HTTP client against a local node:http server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddonError } from '../src/index.ts';
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
  fetchManifest,
  fetchResource,
} from '../src/index.ts';

// A path segment and query that stand in for a configured addon's secrets.
const SECRET = 'SECRETKEY123';
const manifest = {
  id: 'org.example.test',
  version: '1.0.0',
  name: 'Test',
  types: ['movie'],
  resources: ['stream'],
};

const requests: { url: string; accept: string | undefined; custom: string | undefined }[] = [];
let server: Server;
let origin: string;
let host: string;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '';
  requests.push({
    url,
    accept: req.headers.accept,
    custom: req.headers['x-custom'] as string | undefined,
  });
  const path = url.split('?')[0] ?? '';
  const route = path.replace(`/${SECRET}`, '');
  switch (route) {
    case '/manifest.json': {
      json(res, 200, manifest);
      return;
    }
    case '/bad/manifest.json': {
      json(res, 200, { id: 'x' });
      return;
    }
    case '/stream/movie/tt1.json': {
      json(res, 200, {
        streams: [{ url: 'https://example.invalid/1' }, { name: 'no source' }],
        cacheMaxAge: 60,
      });
      return;
    }
    case '/catalog/movie/top/search=Harry%20Potter&skip=100.json': {
      json(res, 200, { metas: [{ id: 'tt1', type: 'movie', name: 'HP' }] });
      return;
    }
    case '/stream/movie/not-found.json': {
      json(res, 404, { err: `not found ${SECRET}` });
      return;
    }
    case '/stream/movie/invalid-json.json':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"streams": [');
    case '/stream/movie/wrong-shape.json': {
      json(res, 200, { hello: 'world' });
      return;
    }
    case '/stream/movie/hang.json':
      // Never answers; the client's timeout must fire.
      return;
    case '/stream/movie/slow-body.json':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"streams": [');
      return; // the body never finishes
    case '/stream/movie/big-declared.json': {
      const body = JSON.stringify({ streams: [], pad: 'x'.repeat(5000) });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      return res.end(body);
    }
    case '/stream/movie/big-chunked.json': {
      // No content-length: the cap must trip while streaming.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"streams": [], "pad": "');
      const timer = setInterval(() => {
        if (res.destroyed || !res.write('x'.repeat(1024))) clearInterval(timer);
      }, 1);
      res.on('close', () => {
        clearInterval(timer);
      });
      return;
    }
    default: {
      json(res, 404, {});
      return;
    }
  }
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${String(port)}`;
  origin = `http://${host}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

const transport = () => `${origin}/${SECRET}/manifest.json?token=${SECRET}`;

/** Runs `fn`, expecting an AddonError of `type`, and checks it leaks no URL parts. */
async function expectAddonError<T extends AddonError>(
  fn: () => Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  const error: unknown = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  const addonError = error as T;
  const serialized = `${addonError.message} ${JSON.stringify(addonError)} ${String(addonError.stack)}`;
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain('manifest.json?');
  expect(serialized).not.toContain('/stream/');
  return addonError;
}

describe('fetchManifest', () => {
  it('fetches and validates a manifest', async () => {
    const result = await fetchManifest(transport(), { headers: { 'x-custom': 'yes' } });
    expect(result).toMatchObject({ id: 'org.example.test', catalogs: [] });
    const last = requests.at(-1);
    expect(last).toEqual({
      url: `/${SECRET}/manifest.json?token=${SECRET}`,
      accept: 'application/json',
      custom: 'yes',
    });
  });

  it('rejects an invalid manifest', async () => {
    const error = await expectAddonError(
      () => fetchManifest(`${origin}/bad/manifest.json`),
      AddonValidationError,
    );
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.host).toBe(host);
  });

  it('rejects URLs that do not end in manifest.json (legacy transport)', async () => {
    const before = requests.length;
    for (const url of [
      `${origin}/${SECRET}/stremio/v1`,
      `${origin}/${SECRET}/`,
      `${origin}/manifest.json/x`,
    ]) {
      const error = await expectAddonError(
        () => fetchManifest(url),
        AddonUnsupportedTransportError,
      );
      expect(error.message).toContain('/manifest.json');
      expect(error.host).toBe(host);
    }
    expect(requests.length).toBe(before);
  });

  it('rejects unparsable and non-http URLs without echoing them', async () => {
    await expectAddonError(() => fetchManifest(`not a url ${SECRET}`), AddonInvalidUrlError);
    await expectAddonError(
      () => fetchManifest(`file:///${SECRET}/manifest.json`),
      AddonInvalidUrlError,
    );
  });
});

describe('fetchResource', () => {
  it('builds the resource URL and drops invalid items', async () => {
    const result = await fetchResource(transport(), {
      resource: 'stream',
      type: 'movie',
      id: 'tt1',
    });
    expect(requests.at(-1)?.url).toBe(`/${SECRET}/stream/movie/tt1.json?token=${SECRET}`);
    expect(result.response.type).toBe('streams');
    expect(result.response.type === 'streams' && result.response.streams.length).toBe(1);
    expect(result.dropped.map((d) => d.index)).toEqual([1]);
    expect(result.cache).toEqual({ cacheMaxAge: 60 });
  });

  it('encodes extra values', async () => {
    const result = await fetchResource(`${origin}/manifest.json`, {
      resource: 'catalog',
      type: 'movie',
      id: 'top',
      extra: [
        { name: 'search', value: 'Harry Potter' },
        { name: 'skip', value: '100' },
      ],
    });
    expect(requests.at(-1)?.url).toBe('/catalog/movie/top/search=Harry%20Potter&skip=100.json');
    expect(result.response.type === 'metas' && result.response.metas[0]?.name).toBe('HP');
  });

  const stream = (id: string) => ({ resource: 'stream', type: 'movie', id });

  it('reports non-2xx statuses', async () => {
    const error = await expectAddonError(
      () => fetchResource(transport(), stream('not-found')),
      AddonHttpStatusError,
    );
    expect(error.status).toBe(404);
    expect(error.code).toBe('http-status');
  });

  it('reports invalid JSON', async () => {
    await expectAddonError(
      () => fetchResource(transport(), stream('invalid-json')),
      AddonInvalidJsonError,
    );
  });

  it('reports a response of the wrong shape', async () => {
    await expectAddonError(
      () => fetchResource(transport(), stream('wrong-shape')),
      AddonValidationError,
    );
  });

  it('times out waiting for headers', async () => {
    const error = await expectAddonError(
      () => fetchResource(transport(), stream('hang'), { timeoutMs: 100 }),
      AddonTimeoutError,
    );
    expect(error.timeoutMs).toBe(100);
  });

  it('times out waiting for the body', async () => {
    await expectAddonError(
      () => fetchResource(transport(), stream('slow-body'), { timeoutMs: 150 }),
      AddonTimeoutError,
    );
  });

  it('reports the caller aborting, before and during the request', async () => {
    await expectAddonError(
      () => fetchResource(transport(), stream('tt1'), { signal: AbortSignal.abort() }),
      AddonAbortedError,
    );
    const controller = new AbortController();
    const pending = fetchResource(transport(), stream('hang'), { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expectAddonError(() => pending, AddonAbortedError);
  });

  it('enforces the size cap from content-length', async () => {
    const error = await expectAddonError(
      () => fetchResource(transport(), stream('big-declared'), { maxBytes: 1000 }),
      AddonResponseTooLargeError,
    );
    expect(error.maxBytes).toBe(1000);
  });

  it('enforces the size cap while streaming', async () => {
    await expectAddonError(
      () =>
        fetchResource(transport(), stream('big-chunked'), { maxBytes: 16 * 1024, timeoutMs: 5000 }),
      AddonResponseTooLargeError,
    );
  });

  it('reports network failures with only the host', async () => {
    // A port that was just freed refuses connections.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) =>
      closed.close(() => {
        resolve();
      }),
    );
    const error = await expectAddonError(
      () =>
        fetchResource(`http://127.0.0.1:${String(port)}/${SECRET}/manifest.json`, stream('tt1')),
      AddonNetworkError,
    );
    expect(error.host).toBe(`127.0.0.1:${String(port)}`);
    // WSL2's mirrored networking answers a closed loopback port with a reset.
    expect(['ECONNREFUSED', 'ECONNRESET']).toContain(error.causeCode);
  });
});
