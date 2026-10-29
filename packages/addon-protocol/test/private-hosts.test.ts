// The private-host guard: the address rules, the allowlist, and guarded fetches
// against local node:http servers (a stand-in "engine" records what reaches it).
import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RedirectError } from '../src/index.ts';
import {
  AddonNetworkError,
  fetchResource,
  isNonPublicAddress,
  MAX_REDIRECTS,
  parseAddress,
  parsePrivateAllow,
  PrivateHostError,
  PrivateHostGuard,
} from '../src/index.ts';

const nonPublic = (address: string) => isNonPublicAddress(parseAddress(address) ?? []);

describe('isNonPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1', // CGNAT
    '100.100.100.200', // Alibaba metadata
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped, dotted
    '::ffff:7f00:1', // IPv4-mapped, hex
    '::ffff:192.168.1.1',
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::7f00:1', // NAT64 of loopback
    '2002:c0a8:101::1', // 6to4 of 192.168.1.1
    'fc00::1',
    'fd00:ec2::254', // AWS metadata
    'fe80::1',
    'ff02::1',
    '[::1]', // as a URL hostname
  ])('refuses %s', (address) => {
    expect(nonPublic(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '64:ff9b::808:808',
  ])('allows %s', (address) => {
    expect(nonPublic(address)).toBe(false);
  });

  it('reads the IPv4 forms the URL parser normalizes', () => {
    for (const url of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://127.1/',
      'http://[::ffff:127.0.0.1]/',
    ]) {
      expect(nonPublic(new URL(url).hostname)).toBe(true);
    }
  });
});

describe('parsePrivateAllow', () => {
  it('takes IPs, CIDRs and host names', () => {
    const list = parsePrivateAllow([' 192.168.1.20 ', '10.0.0.0/24', 'fd00::/8', 'NAS.lan.', '']);
    expect(list.exact).toHaveLength(1);
    expect(list.ranges).toHaveLength(2);
    expect([...list.names]).toEqual(['nas.lan']);
  });

  it.each(['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/8/1', 'not a host', 'http://nas.lan', '::1/129'])(
    'refuses %s',
    (entry) => {
      expect(() => parsePrivateAllow([entry])).toThrow();
    },
  );
});

describe('PrivateHostGuard.allows', () => {
  const guard = new PrivateHostGuard({
    allow: ['192.168.1.20', '10.0.0.0/24', '169.254.0.0/16', 'nas.lan', '::ffff:172.16.0.0/108'],
  });

  it('lets public addresses through', () => {
    expect(guard.allows('example.org', '93.184.216.34')).toBe(true);
  });

  it('lets only listed private addresses through', () => {
    expect(guard.allows('x', '192.168.1.20')).toBe(true);
    expect(guard.allows('x', '::ffff:192.168.1.20')).toBe(true);
    expect(guard.allows('x', '192.168.1.21')).toBe(false);
    expect(guard.allows('x', '10.0.0.200')).toBe(true);
    expect(guard.allows('x', '10.0.1.1')).toBe(false);
    expect(guard.allows('x', '172.16.5.5')).toBe(true);
    expect(guard.allows('x', '127.0.0.1')).toBe(false);
  });

  it('lets a listed host name reach its private addresses', () => {
    expect(guard.allows('NAS.lan', '192.168.1.99')).toBe(true);
    expect(guard.allows('nas.lan.', '127.0.0.1')).toBe(true);
    expect(guard.allows('other.lan', '192.168.1.99')).toBe(false);
  });

  it('exempts a metadata address only when it is listed exactly', () => {
    expect(guard.allows('x', '169.254.1.1')).toBe(true);
    expect(guard.allows('x', '169.254.169.254')).toBe(false);
    expect(guard.allows('nas.lan', '169.254.169.254')).toBe(false);
    expect(
      new PrivateHostGuard({ allow: ['169.254.169.254'] }).allows('x', '169.254.169.254'),
    ).toBe(true);
  });

  it('refuses everything private with no allowlist', () => {
    expect(new PrivateHostGuard().allows('localhost', '127.0.0.1')).toBe(false);
  });
});

describe('PrivateHostGuard.fetch', () => {
  let engine: Server;
  let addon: Server;
  let enginePort = 0;
  let addonOrigin = '';
  const engineHits: { url: string; host: string; authorization: string | undefined }[] = [];
  /** Where the addon redirects, per path. */
  const redirects = new Map<string, string>();

  function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  beforeAll(async () => {
    engine = createServer((req, res) => {
      engineHits.push({
        url: req.url ?? '',
        host: req.headers.host ?? '',
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    enginePort = await listen(engine);
    addon = createServer((req, res) => {
      const path = req.url ?? '';
      const location = redirects.get(path) ?? (path.startsWith('/loop') ? path : undefined);
      if (location === undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"streams":[]}');
        return;
      }
      res.writeHead(302, { location });
      res.end();
    });
    addonOrigin = `http://127.0.0.1:${String(await listen(addon))}`;
  });

  afterAll(async () => {
    await Promise.all(
      [engine, addon].map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => {
              r();
            });
          }),
      ),
    );
  });

  beforeEach(() => {
    engineHits.length = 0;
    redirects.clear();
  });

  /** The `cause` a refused fetch rejects with. */
  async function causeOf(promise: Promise<unknown>): Promise<unknown> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    return (err as TypeError).cause;
  }

  const engineUrl = (path: string, host = '127.0.0.1') =>
    `http://${host}:${String(enginePort)}${path}`;

  it('trusts the first hop and refuses a redirect to a loopback address', async () => {
    redirects.set('/r', engineUrl('/removeAll'));
    const cause = await causeOf(
      new PrivateHostGuard().fetch(`${addonOrigin}/r`, {}, { trustFirstHop: true }),
    );
    expect(cause).toBeInstanceOf(PrivateHostError);
    expect(engineHits).toEqual([]);
  });

  it('refuses the first hop to a private literal when it is not trusted', async () => {
    const cause = await causeOf(new PrivateHostGuard().fetch(engineUrl('/removeAll')));
    expect((cause as PrivateHostError).code).toBe('ERR_PRIVATE_HOST');
    expect(engineHits).toEqual([]);
  });

  it('refuses IPv4-mapped and numeric spellings of loopback', async () => {
    const guard = new PrivateHostGuard();
    for (const host of ['[::ffff:127.0.0.1]', '2130706433', '0x7f.0.0.1']) {
      expect(await causeOf(guard.fetch(engineUrl('/removeAll', host)))).toBeInstanceOf(
        PrivateHostError,
      );
    }
    expect(engineHits).toEqual([]);
  });

  it('checks a name at connect time, on the address it resolves to', async () => {
    // A name that looks public until it resolves (DNS rebinding): only the
    // connection's own lookup decides.
    const lookups: string[] = [];
    const lookup = (
      hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ) => {
      lookups.push(hostname);
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };
    redirects.set('/r', engineUrl('/removeAll', 'rebind.example'));
    const cause = await causeOf(
      new PrivateHostGuard({ lookup }).fetch(`${addonOrigin}/r`, {}, { trustFirstHop: true }),
    );
    expect(cause).toBeInstanceOf(PrivateHostError);
    expect(lookups).toEqual(['rebind.example']);
    expect(engineHits).toEqual([]);

    // Listed by name, the same hop goes through.
    const allowed = new PrivateHostGuard({ lookup, allow: ['rebind.example'] });
    const res = await allowed.fetch(`${addonOrigin}/r`, {}, { trustFirstHop: true });
    expect(res.status).toBe(200);
    expect(engineHits).toEqual([
      expect.objectContaining({ url: '/removeAll', host: `rebind.example:${String(enginePort)}` }),
    ]);
  });

  it('refuses a real name that resolves to loopback', async () => {
    const cause = await causeOf(new PrivateHostGuard().fetch(engineUrl('/x', 'localhost')));
    expect(cause).toBeInstanceOf(PrivateHostError);
    expect(engineHits).toEqual([]);
  });

  it('follows a redirect to an allowlisted host, dropping authorization across origins', async () => {
    redirects.set('/r', engineUrl('/ok'));
    const guard = new PrivateHostGuard({ allow: ['127.0.0.1'] });
    const res = await guard.fetch(`${addonOrigin}/r`, { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
    expect(engineHits).toEqual([expect.objectContaining({ url: '/ok', authorization: undefined })]);
  });

  it('returns the redirect itself unless asked to follow', async () => {
    redirects.set('/r', engineUrl('/removeAll'));
    const res = await new PrivateHostGuard().fetch(
      `${addonOrigin}/r`,
      { redirect: 'manual' },
      { trustFirstHop: true },
    );
    expect(res.status).toBe(302);
    expect(engineHits).toEqual([]);
  });

  it('gives up after MAX_REDIRECTS', async () => {
    const guard = new PrivateHostGuard({ allow: ['127.0.0.1'] });
    const cause = await causeOf(guard.fetch(`${addonOrigin}/loop`));
    expect((cause as RedirectError).code).toBe('ERR_TOO_MANY_REDIRECTS');
    expect(MAX_REDIRECTS).toBe(20);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    redirects.set('/r', 'file:///etc/passwd');
    const cause = await causeOf(
      new PrivateHostGuard().fetch(`${addonOrigin}/r`, {}, { trustFirstHop: true }),
    );
    expect((cause as RedirectError).code).toBe('ERR_INVALID_REDIRECT');
  });

  it('makes the addon client fail a refused redirect as a network error', async () => {
    redirects.set('/stream/movie/tt1.json', engineUrl('/removeAll'));
    const err = await fetchResource(`${addonOrigin}/manifest.json`, {
      resource: 'stream',
      type: 'movie',
      id: 'tt1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AddonNetworkError);
    expect((err as AddonNetworkError).causeCode).toBe('ERR_PRIVATE_HOST');
    expect(engineHits).toEqual([]);
  });

  it('lets the addon client follow a redirect its guard allows', async () => {
    redirects.set('/stream/movie/tt1.json', `${addonOrigin}/moved/stream/movie/tt1.json`);
    const data = await fetchResource(
      `${addonOrigin}/manifest.json`,
      { resource: 'stream', type: 'movie', id: 'tt1' },
      { guard: new PrivateHostGuard({ allow: ['127.0.0.1'] }) },
    );
    expect(data.response.type).toBe('streams');
  });
});
