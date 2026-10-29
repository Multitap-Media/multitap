/**
 * The private-host guard for fetches of addon-chosen URLs
 * (okf:architecture/addon-private-host-guard).
 *
 * Multitap is the one machine allowed to reach the unauthenticated engine, so an
 * addon must not be able to aim Multitap's own requests at the engine or the LAN.
 * A guarded hop refuses loopback, private, link-local, CGNAT, metadata,
 * unspecified and other non-public addresses (IPv4-mapped IPv6 included):
 *
 * - an IP-literal host is checked before the request;
 * - a name is checked at connect time, on the addresses the connection
 *   actually uses (an undici dispatcher with a `lookup` check), so DNS
 *   rebinding can't swap in a private address after a check;
 * - redirects are followed here, one hop at a time, and every hop is guarded.
 *
 * The operator's allowlist (`MULTITAP_ADDON_PRIVATE_ALLOW`: IPs, CIDRs and host names)
 * exempts LAN addons and subtitle hosts, like the engine's own allowlists:
 * only listed entries, and a metadata address only when listed exactly.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

/** The error behind a refused hop: `cause` of the `fetch failed` TypeError. */
export class PrivateHostError extends Error {
  override name = 'PrivateHostError';
  readonly code = 'ERR_PRIVATE_HOST';
  /** The refused host name or address, never the URL (it can hold secrets). */
  readonly host: string;

  constructor(host: string) {
    super(`Refused a request to the private address of ${host}`);
    this.host = host;
  }
}

/** Why a redirect chain was given up, as the `cause` of a `fetch failed` TypeError. */
export class RedirectError extends Error {
  override name = 'RedirectError';
  readonly code: 'ERR_TOO_MANY_REDIRECTS' | 'ERR_INVALID_REDIRECT';

  constructor(code: RedirectError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** The most redirects followed per request, as in browsers. */
export const MAX_REDIRECTS = 20;

type Bytes = readonly number[];

interface Cidr {
  bytes: Bytes;
  prefix: number;
}

function parseIpv4(text: string): Bytes | undefined {
  if (isIP(text) !== 4) return undefined;
  return text.split('.').map(Number);
}

function parseIpv6(text: string): Bytes | undefined {
  if (isIP(text) !== 6) return undefined;
  let body = text.toLowerCase();
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is two hextets.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (tail !== null) {
    const v4 = parseIpv4(tail[2] ?? '') ?? [0, 0, 0, 0];
    const hex = (hi = 0, lo = 0) => ((hi << 8) | lo).toString(16);
    body = `${tail[1] ?? ''}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const [head = '', rest] = body.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const hextets = [...left, ...Array<string>(fill).fill('0'), ...right].map((h) =>
    Number.parseInt(h, 16),
  );
  return hextets.flatMap((h) => [h >> 8, h & 0xff]);
}

/** An IP literal (brackets allowed) as bytes; IPv4-mapped IPv6 becomes IPv4. */
export function parseAddress(text: string): Bytes | undefined {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const v4 = parseIpv4(bare);
  if (v4 !== undefined) return v4;
  const v6 = parseIpv6(bare);
  if (v6 === undefined) return undefined;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

function cidr(text: string): Cidr {
  const [address = '', prefix, extra] = text.split('/');
  if (extra !== undefined) throw new Error(`invalid CIDR: ${text}`);
  const bytes = parseAddress(address);
  if (bytes === undefined) throw new Error(`not an IP address: ${address}`);
  // A mapped address in a rule means its IPv4 form.
  const bits = bytes.length * 8;
  const fromV6 = parseIpv6(address) !== undefined && bytes.length === 4;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) {
    throw new Error(`invalid prefix length: ${text}`);
  }
  let n = prefix === undefined ? bits : Number(prefix);
  if (fromV6 && prefix !== undefined) n -= 96;
  if (n < 0 || n > bits) {
    throw new Error(`invalid prefix length: ${text}`);
  }
  return { bytes, prefix: n };
}

function inCidr(bytes: Bytes, range: Cidr): boolean {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.prefix; bit += 8) {
    const width = Math.min(8, range.prefix - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    const i = bit / 8;
    if (((bytes[i] ?? 0) & mask) !== ((range.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}

/** Addresses that are never public: RFC 6890 special-purpose blocks and the like. */
const NON_PUBLIC = [
  '0.0.0.0/8', // "this network", unspecified
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, cloud metadata
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, broadcast
  '::/96', // unspecified, loopback, IPv4-compatible
  '64:ff9b:1::/48', // local-use NAT64
  '100::/64', // discard
  '2001:db8::/32',
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local
  'ff00::/8', // multicast
].map(cidr);

/** IPv6 prefixes that embed an IPv4 address, which decides for them: [prefix, offset]. */
const EMBEDS_IPV4: [Cidr, number][] = [
  [cidr('64:ff9b::/96'), 12], // NAT64
  [cidr('2002::/16'), 2], // 6to4
];

/** Cloud metadata services: exempt only when the allowlist names them exactly. */
const METADATA = ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254'].map(
  (a) => parseAddress(a) ?? [],
);

const same = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether an address (bytes from {@link parseAddress}) is outside public address space. */
export function isNonPublicAddress(bytes: Bytes): boolean {
  if (NON_PUBLIC.some((range) => inCidr(bytes, range))) return true;
  for (const [range, offset] of EMBEDS_IPV4) {
    if (inCidr(bytes, range)) return isNonPublicAddress(bytes.slice(offset, offset + 4));
  }
  return false;
}

function isMetadataAddress(bytes: Bytes): boolean {
  return METADATA.some((m) => same(m, bytes));
}

/** A host name as an allowlist entry: lower case, no trailing dot. */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/;

function hostKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * Parses `MULTITAP_ADDON_PRIVATE_ALLOW`-style entries: IP addresses, CIDRs and host
 * names. Throws on an entry that is none of them, naming it.
 */
export function parsePrivateAllow(entries: readonly string[]): PrivateAllowList {
  const ranges: Cidr[] = [];
  const exact: Bytes[] = [];
  const names = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    if (entry.includes('/')) {
      ranges.push(cidr(entry));
      continue;
    }
    const bytes = parseAddress(entry);
    if (bytes !== undefined) {
      exact.push(bytes);
      continue;
    }
    const name = hostKey(entry);
    if (!HOST_NAME.test(name)) throw new Error(`not an IP, CIDR or host name: ${entry}`);
    names.add(name);
  }
  return { ranges, exact, names };
}

export interface PrivateAllowList {
  readonly ranges: readonly Cidr[];
  readonly exact: readonly Bytes[];
  readonly names: ReadonlySet<string>;
}

type LookupAll = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface PrivateHostGuardOptions {
  /** IPs, CIDRs and host names a guarded hop may reach although they are private. */
  allow?: readonly string[];
  /** Test seam: resolves host names at connect time. Default `dns.lookup`. */
  lookup?: LookupAll;
}

export interface GuardedFetchOptions {
  /**
   * The first hop goes to a URL the operator chose (an installed addon's
   * transport URL), so only the redirects after it are guarded.
   */
  trustFirstHop?: boolean;
  /** The `fetch` behind every hop. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

/**
 * Guards fetches of addon-chosen URLs. One instance per allowlist; its
 * dispatcher (one connection pool) is created on first use.
 */
export class PrivateHostGuard {
  readonly #allow: PrivateAllowList;
  readonly #lookup: LookupAll;
  #agent: Agent | undefined;

  constructor(options: PrivateHostGuardOptions = {}) {
    this.#allow = parsePrivateAllow(options.allow ?? []);
    this.#lookup = options.lookup ?? dnsLookup;
  }

  /** Whether a guarded hop to `host` may use `address` (an IP literal). */
  allows(host: string, address: string): boolean {
    const bytes = parseAddress(address);
    // Not an address at all: nothing to connect to, so nothing to allow.
    if (bytes === undefined) return false;
    if (!isNonPublicAddress(bytes)) return true;
    if (this.#allow.exact.some((entry) => same(entry, bytes))) return true;
    if (isMetadataAddress(bytes)) return false;
    if (this.#allow.names.has(hostKey(host))) return true;
    return this.#allow.ranges.some((range) => inCidr(bytes, range));
  }

  /**
   * Whether something else (the engine) may be sent to `url`: an IP literal is
   * checked directly, a host name by resolving it now, and every address it
   * resolves to must be allowed. `undefined` when the name doesn't resolve:
   * there is nothing to check, and whoever connects resolves it again.
   */
  async allowsUrl(url: URL): Promise<boolean | undefined> {
    const host = url.hostname;
    if (parseAddress(host) !== undefined) return this.allows(host, host);
    const addresses = await new Promise<LookupAddress[] | undefined>((resolve) => {
      this.#lookup(host, { all: true }, (err, found) => {
        resolve(err === null ? found : undefined);
      });
    });
    if (addresses === undefined || addresses.length === 0) return undefined;
    return addresses.every((a) => this.allows(host, a.address));
  }

  /**
   * A GET (or HEAD) through the guard. Redirects are followed here when
   * `init.redirect` is `follow` (the default), at most {@link MAX_REDIRECTS},
   * to http(s) only, dropping `authorization` and `cookie` when the origin
   * changes. A refused hop rejects like a network failure: a `TypeError`
   * whose `cause` is a {@link PrivateHostError}.
   */
  async fetch(
    input: string | URL,
    init: RequestInit = {},
    options: GuardedFetchOptions = {},
  ): Promise<Response> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const follow = (init.redirect ?? 'follow') === 'follow';
    const headers = new Headers(init.headers);
    let url = new URL(input);
    for (let hop = 0; ; hop++) {
      const guarded = hop > 0 || options.trustFirstHop !== true;
      const hopInit: RequestInit = {
        ...init,
        headers,
        redirect: 'manual',
      };
      if (guarded) {
        // An IP literal never reaches `lookup`, so it is checked here.
        if (parseAddress(url.hostname) !== undefined && !this.allows(url.hostname, url.hostname)) {
          throw fetchFailed(new PrivateHostError(url.hostname));
        }
        hopInit.dispatcher = this.#dispatcher();
      }
      const response = await doFetch(url, hopInit);
      const location = response.headers.get('location');
      if (!follow || !REDIRECTS.has(response.status) || location === null) return response;
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) {
        throw fetchFailed(new RedirectError('ERR_TOO_MANY_REDIRECTS', 'too many redirects'));
      }
      const next = URL.parse(location, url);
      if (next === null || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
        throw fetchFailed(new RedirectError('ERR_INVALID_REDIRECT', 'redirect is not http(s)'));
      }
      if (next.origin !== url.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
      }
      url = next;
    }
  }

  #dispatcher(): Agent {
    this.#agent ??= new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          this.#lookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err !== null) {
              callback(err, '');
              return;
            }
            if (addresses.some((a) => !this.allows(hostname, a.address))) {
              callback(new PrivateHostError(hostname), '');
              return;
            }
            const first = addresses[0];
            if (options.all === true) callback(null, addresses);
            else if (first !== undefined) callback(null, first.address, first.family);
            else
              callback(
                Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }),
                '',
              );
          });
        },
      },
    });
    return this.#agent;
  }
}

/** The guard with no allowlist: what addon requests use unless given one. */
export const defaultPrivateHostGuard = new PrivateHostGuard();
