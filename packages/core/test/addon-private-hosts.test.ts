/**
 * Multitap's fetches of addon-chosen URLs never reach a private host the operator
 * hasn't listed (okf:architecture/addon-private-host-guard). Started as the
 * adversarial review's sec-input PoC (okf:core-review/sec-input-addon-redirect-ssrf,
 * okf:core-review/sec-input-subtitle-ssrf): a stand-in "engine" on 127.0.0.1
 * records the GETs it receives (`/removeAll` is a real GET control route on
 * stremio-server-go). Everything runs on loopback; no real hosts.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchResource, PrivateHostGuard } from '@multitap/addon-protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { loadConfig } from '../src/config.ts';
import { SubtitleFileError, SubtitleService } from '../src/subtitles/index.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

let engine: Server;
let addon: Server;
let installable: Server;
let engineBase = '';
let addonBase = '';
let installableBase = '';
const engineHits: string[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });
}

beforeAll(async () => {
  engine = createServer((req, res) => {
    engineHits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  engineBase = await listen(engine);
  // A "public" addon whose every resource answer is a redirect to the engine.
  addon = createServer((req, res) => {
    res.writeHead(302, { location: `${engineBase}/removeAll` });
    res.end();
  });
  addonBase = await listen(addon);
  // The same, with a manifest an admin can install (from loopback: trusted).
  installable = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'org.example.hostile',
          version: '1.0.0',
          name: 'Hostile',
          types: ['movie'],
          resources: ['stream'],
          catalogs: [],
          idPrefixes: ['tt'],
        }),
      );
      return;
    }
    res.writeHead(302, { location: `${engineBase}/removeAll` });
    res.end();
  });
  installableBase = await listen(installable);
});

afterAll(async () => {
  await Promise.all(
    [engine, addon, installable].map(
      (s) =>
        new Promise<void>((r) =>
          s.close(() => {
            r();
          }),
        ),
    ),
  );
});

beforeEach(() => {
  engineHits.length = 0;
});

async function viaAddonRedirect(): Promise<string[]> {
  await fetchResource(`${addonBase}/manifest.json`, {
    resource: 'stream',
    type: 'movie',
    id: 'tt0000001',
  }).catch(() => undefined);
  return [...engineHits];
}

function subtitleService(guard?: PrivateHostGuard): SubtitleService {
  const addons = {
    aggregate: () =>
      Promise.resolve({
        addons: [
          {
            addonId: 'hostile',
            addonName: 'Hostile',
            status: 'ok',
            dropped: 0,
            items: [{ id: 'x', lang: 'eng', url: `${engineBase}/removeAll` }],
          },
        ],
      }),
  } as unknown as AddonService;
  const deps: ConstructorParameters<typeof SubtitleService>[0] = {
    addons,
    clock: manualClock(),
    logger: memoryLogger('info').logger,
  };
  if (guard !== undefined) deps.guard = guard;
  return new SubtitleService(deps);
}

async function viaSubtitleUrl(guard?: PrivateHostGuard): Promise<unknown> {
  const subs = subtitleService(guard);
  const list = await subs.list('movie', 'tt0000001');
  const id = list.subtitles[0]?.id ?? '';
  return subs.file(id).catch((err: unknown) => err);
}

it('an addon redirect cannot steer Multitap to a loopback/private host', async () => {
  expect(await viaAddonRedirect()).toEqual([]);
});

it('a subtitle URL cannot point Multitap at a loopback/private host', async () => {
  const err = await viaSubtitleUrl();
  expect(engineHits).toEqual([]);
  // Refused like any unreachable host: no status to probe with.
  expect(err).toBeInstanceOf(SubtitleFileError);
  expect((err as SubtitleFileError).code).toBe('network');
});

it('a subtitle host the operator lists is fetched', async () => {
  await viaSubtitleUrl(new PrivateHostGuard({ allow: ['127.0.0.1'] }));
  expect(engineHits).toEqual(['GET /removeAll']);
});

describe('through the addon service', () => {
  async function service(env: Record<string, string> = {}) {
    const db = await migratedMemoryDb();
    const config = loadConfig({
      NODE_ENV: 'test',
      MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '2000',
      ...env,
    });
    return new AddonService({
      config,
      db,
      logger: memoryLogger('info').logger,
      clock: manualClock(),
    });
  }

  it('installs an addon from a private manifest URL, but refuses its redirects', async () => {
    const addons = await service();
    await addons.collection.add(`${installableBase}/manifest.json`);
    const result = await addons.aggregate('stream', 'movie', 'tt0000001');
    expect(result.addons.map((a) => [a.status, a.errorCode])).toEqual([['error', 'network']]);
    expect(engineHits).toEqual([]);
  });

  it('follows the redirect when MULTITAP_ADDON_PRIVATE_ALLOW lists the host', async () => {
    const addons = await service({ MULTITAP_ADDON_PRIVATE_ALLOW: '127.0.0.0/8' });
    await addons.collection.add(`${installableBase}/manifest.json`);
    await addons.aggregate('stream', 'movie', 'tt0000001');
    expect(engineHits).toEqual(['GET /removeAll']);
  });

  it('refuses an invalid MULTITAP_ADDON_PRIVATE_ALLOW entry at startup', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', MULTITAP_ADDON_PRIVATE_ALLOW: '10.0.0.0/40' }),
    ).toThrow(/MULTITAP_ADDON_PRIVATE_ALLOW/);
  });
});
