/**
 * The engine's proxy password reaches only the `/proxy/stream` URL Multitap
 * builds for a `proxy` plan, and only for a target the private-host guard
 * allows (okf:core-review/sec-input-engine-proxy-password). Before, an addon's
 * plain `url` stream at the engine's own `/proxy/stream` got the password
 * appended, and a `proxyHeaders` stream reached hosts listed only in the
 * engine's `/proxy` allowlist through the media routes. Fake values only.
 */
import { PrivateHostGuard } from '@multitap/addon-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import { ServerGoEngineModule } from '../src/engines/engine-module.ts';
import { putEngine } from '../src/engines/index.ts';
import type { PrepareRequest } from '../src/engines/module.ts';
import { EngineRegistry } from '../src/engines/registry.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { HOME_ENGINE, PUBLIC_DNS_GUARD } from './engine-fixture.ts';
import { FakeEngine } from './fakes/engine.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

const PROXY_PASSWORD = 'FAKEproxyPASSWORD-0123456789';
const PROXY_HEADERS = { proxyHeaders: { request: { 'User-Agent': 'Agent/1.0' } } };
const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.destroy()));
});

async function setup(privateHosts: PrivateHostGuard = PUBLIC_DNS_GUARD) {
  const db = await migratedMemoryDb();
  dbs.push(db);
  await putEngine(db, 'home', {
    ...HOME_ENGINE,
    address: 'http://engine.test:11470',
    proxyPassword: PROXY_PASSWORD,
  });
  const fake = new FakeEngine({ proxyPassword: PROXY_PASSWORD });
  const registry = new EngineRegistry({
    db,
    timeouts: { control: 2_000, prepare: 2_000, media: 2_000 },
    transportFactory: () => fake.transport('home'),
  });
  const module = new ServerGoEngineModule({
    db,
    registry,
    logger: memoryLogger('info').logger,
    clock: manualClock(),
    ids: sequentialIds(),
    privateHosts,
  });
  const prepare = async (stream: Record<string, unknown>) => {
    const result = await module.prepare({
      engineId: 'home',
      sessionKey: 'ps_one',
      stream: stream as PrepareRequest['stream'],
      mode: 'play',
    });
    await module.idle();
    return result;
  };
  const probed = () =>
    fake.requests
      .filter((r) => r.path === '/hlsv2/probe')
      .map((r) => new URL(r.query.mediaURL ?? ''));
  return { prepare, probed };
}

// A LAN host listed only in the engine's STREMIO_PROXY_PRIVATE_ALLOW, say.
const LAN_TARGET = Buffer.from('http://nas.lan.test/private.mkv').toString('base64url');

describe('addon url streams that point at the engine are refused', () => {
  it.each([
    `http://127.0.0.1:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://localhost:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://[::1]:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://[::ffff:127.0.0.1]:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://2130706433:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://0.0.0.0:11470/proxy/stream?d=${LAN_TARGET}`,
    `http://engine.test:11470/proxy/stream?d=${LAN_TARGET}`,
    'http://127.0.0.1:9/movie.mkv',
  ])('%s', async (url) => {
    const { prepare, probed } = await setup();
    const result = await prepare({ url });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported', retryable: false });
    expect(probed()).toEqual([]);
  });
});

describe('the proxy password', () => {
  it('goes on the /proxy/stream URL Multitap builds for a proxyHeaders source', async () => {
    const { prepare, probed } = await setup();
    const result = await prepare({
      url: 'https://media.example/movie.mkv',
      behaviorHints: PROXY_HEADERS,
    });
    expect(result.ok).toBe(true);
    expect(probed()[0]?.searchParams.get('api_password')).toBe(PROXY_PASSWORD);
  });

  it('never goes on an addon url stream', async () => {
    const { prepare, probed } = await setup();
    const result = await prepare({ url: 'https://media.example/movie.mkv' });
    expect(result.ok).toBe(true);
    expect(probed()[0]?.searchParams.get('api_password')).toBeNull();
  });
});

describe('proxyHeaders targets go through the private-host guard', () => {
  it.each([
    'http://192.168.1.20/private.mkv',
    'http://127.0.0.1:8080/x.mkv',
    'http://[fd00::1]/x.mkv',
  ])('a private target is refused: %s', async (url) => {
    const { prepare, probed } = await setup();
    const result = await prepare({ url, behaviorHints: PROXY_HEADERS });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(probed()).toEqual([]);
  });

  it('a host name that resolves to a private address is refused', async () => {
    const lan = new PrivateHostGuard({
      lookup: (_host, _options, callback) => {
        callback(null, [{ address: '10.0.0.7', family: 4 }]);
      },
    });
    const { prepare, probed } = await setup(lan);
    const result = await prepare({
      url: 'http://nas.lan.test/x.mkv',
      behaviorHints: PROXY_HEADERS,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(probed()).toEqual([]);
  });

  it('a private target listed in MULTITAP_ADDON_PRIVATE_ALLOW plays, with the password', async () => {
    const { prepare, probed } = await setup(new PrivateHostGuard({ allow: ['192.168.1.20'] }));
    const result = await prepare({
      url: 'http://192.168.1.20/private.mkv',
      behaviorHints: PROXY_HEADERS,
    });
    expect(result.ok).toBe(true);
    expect(probed()[0]?.searchParams.get('api_password')).toBe(PROXY_PASSWORD);
  });
});
