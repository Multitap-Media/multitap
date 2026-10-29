/**
 * The engine module against the fake engine (phase 2 step 3): every row of the
 * resolution matrix, the probe rules, quality overrides, warm-up, status,
 * release and self-heal. No ffmpeg, no network.
 */
import type { EngineCapabilities, EngineStatus } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import {
  engineModuleConfig,
  EngineSessionNotFoundError,
  firstSegments,
  ServerGoEngineModule,
  warmPlaylists,
} from '../src/engines/engine-module.ts';
import { safeEngineText } from '../src/engines/server-go.ts';
import { putEngine } from '../src/engines/index.ts';
import { HOME_ENGINE, PUBLIC_DNS_GUARD } from './engine-fixture.ts';
import type { PrepareRequest } from '../src/engines/module.ts';
import { EngineRegistry } from '../src/engines/registry.ts';
import { loadConfig, type LogLevel } from '../src/config.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { FakeEngine, type FakeEngineOptions } from './fakes/engine.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

const IH = '0123456789abcdef0123456789abcdef01234567';
const SELF = 'http://127.0.0.1:11470';
const MOVIE = 'https://media.example/movie.mkv';
// Fake values only.
const PROXY_PASSWORD = 'FAKEproxyPASSWORD-0123456789';
const PROXIED = {
  url: MOVIE,
  behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'Agent/1.0' } } },
};

interface SetupOptions {
  fake?: FakeEngineOptions;
  caps?: Partial<EngineCapabilities>;
  sessionTtlSec?: number;
  warmSegments?: number;
  busyRetryMaxMs?: number;
  /** The engine descriptor's proxy password (stored like `PUT` does). */
  proxyPassword?: string;
  logLevel?: LogLevel;
}

const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.destroy()));
});

async function setup(options: SetupOptions = {}) {
  const db = await migratedMemoryDb();
  dbs.push(db);
  await putEngine(db, 'home', {
    ...HOME_ENGINE,
    address: 'http://engine.test:11470',
    capabilities: { ...HOME_ENGINE.capabilities, ...options.caps },
    ...(options.proxyPassword === undefined ? {} : { proxyPassword: options.proxyPassword }),
  });
  const fake = new FakeEngine({
    torrents: {
      [IH]: {
        files: [
          { name: 'Sample/sample.mkv', length: 10 },
          { name: 'Movie (2026)/Movie.2026.1080p.mkv', length: 5_000 },
          { name: 'Movie (2026)/extras.mkv', length: 900 },
        ],
        peers: 7,
        downloadSpeed: 2_500_000,
      },
    },
    ...options.fake,
  });
  const registry = new EngineRegistry({
    db,
    timeouts: { control: 2_000, prepare: 2_000, media: 2_000 },
    transportFactory: () => fake.transport('home'),
  });
  const log = memoryLogger(options.logLevel ?? 'info');
  const clock = manualClock();
  const ids = sequentialIds();
  const make = () =>
    new ServerGoEngineModule({
      db,
      registry,
      logger: log.logger,
      clock,
      ids,
      privateHosts: PUBLIC_DNS_GUARD,
      ...(options.sessionTtlSec === undefined ? {} : { sessionTtlSec: options.sessionTtlSec }),
      ...(options.warmSegments === undefined ? {} : { warmSegments: options.warmSegments }),
      ...(options.busyRetryMaxMs === undefined ? {} : { busyRetryMaxMs: options.busyRetryMaxMs }),
    });
  const module = make();
  const prepare = (stream: Record<string, unknown>, extra: Partial<PrepareRequest> = {}) =>
    module.prepare({
      engineId: 'home',
      sessionKey: 'ps_one',
      stream: stream as PrepareRequest['stream'],
      mode: 'play',
      ...extra,
    });
  return { db, fake, registry, module, make, prepare, log, clock };
}

describe('resolution matrix', () => {
  it('torrent with fileIdx: create with peerSearch sources, engine-local mediaURL', async () => {
    const { fake, prepare } = await setup();
    const statuses: EngineStatus['phase'][] = [];
    const result = await prepare(
      {
        infoHash: IH.toUpperCase(),
        fileIdx: 1,
        sources: [
          'tracker:udp://tracker.example:1337/announce',
          'dht:' + IH,
          'udp://bare.example:80',
        ],
      },
      { onStatus: (s) => statuses.push(s.phase) },
    );
    expect(result.ok).toBe(true);
    expect(fake.creates).toEqual([
      {
        infoHash: IH,
        body: {
          peerSearch: {
            sources: [
              'tracker:udp://tracker.example:1337/announce',
              `dht:${IH}`,
              'tracker:udp://bare.example:80',
            ],
          },
        },
      },
    ]);
    // The trackers (not the DHT entry) ride along, so the engine can reopen the torrent alone.
    expect(fake.masterRequests[0]?.mediaURL).toBe(
      `${SELF}/${IH}/1?tr=${encodeURIComponent('udp://tracker.example:1337/announce')}` +
        `&tr=${encodeURIComponent('udp://bare.example:80')}`,
    );
    expect(statuses).toEqual(['metadata', 'probing', 'ready']);
  });

  it('torrent without fileIdx: the filename becomes a path-anchored fileMustInclude', async () => {
    const { fake, prepare } = await setup();
    const result = await prepare({ infoHash: IH, behaviorHints: { filename: 'extras.mkv' } });
    expect(result.ok).toBe(true);
    expect(fake.creates[0]?.body).toEqual({
      guessFileIdx: true,
      fileMustInclude: ['/(?:^|/)extras\\.mkv$/'],
    });
    expect(fake.masterRequests[0]?.mediaURL).toBe(`${SELF}/${IH}/2`);
  });

  it("torrent without fileIdx: the addon's fileMustInclude wins over the filename", async () => {
    const { fake, prepare } = await setup();
    const result = await prepare({
      infoHash: IH,
      fileMustInclude: ['extras'],
      behaviorHints: { filename: 'x.mkv' },
    });
    expect(result.ok).toBe(true);
    expect(fake.creates[0]?.body).toEqual({ guessFileIdx: true, fileMustInclude: ['extras'] });
    expect(fake.masterRequests[0]?.mediaURL).toBe(`${SELF}/${IH}/2`);
  });

  it('torrent without fileIdx or hints: the engine guesses the main file', async () => {
    const { fake, prepare } = await setup();
    expect((await prepare({ infoHash: IH })).ok).toBe(true);
    expect(fake.creates[0]?.body).toEqual({ guessFileIdx: true });
    expect(fake.masterRequests[0]?.mediaURL).toBe(`${SELF}/${IH}/1`);
  });

  it('torrent without metadata in time → torrent-failed, retryable', async () => {
    const { fake, prepare } = await setup();
    const other = 'f'.repeat(40);
    expect(await prepare({ infoHash: other })).toEqual({
      ok: false,
      reason: 'torrent-failed',
      retryable: true,
    });
    expect(fake.masterRequests).toEqual([]);
  });

  it('torrent create refused at the engine cap (503): waits Retry-After, capped, and retries once', async () => {
    const { fake, prepare, log } = await setup({ busyRetryMaxMs: 20 });
    fake.busyCreates = 1;
    const result = await prepare({ infoHash: IH, fileIdx: 1 });
    expect(result.ok).toBe(true);
    expect(fake.creates).toHaveLength(2);
    // Retry-After: 5 is capped by busyRetryMaxMs.
    expect(log.text()).toContain('retrying the create once');
    expect(log.text()).toContain('"waitMs":20');
  });

  it('torrent create still refused after the wait → engine-busy, retryable', async () => {
    const { fake, prepare } = await setup({ busyRetryMaxMs: 0 });
    fake.busyCreates = 2;
    expect(await prepare({ infoHash: IH, fileIdx: 1 })).toEqual({
      ok: false,
      reason: 'engine-busy',
      retryable: true,
    });
    expect(fake.creates).toHaveLength(2);
    expect(fake.masterRequests).toEqual([]);
  });

  it('torrent fileIdx past the last file → torrent-failed', async () => {
    const { prepare } = await setup();
    expect(await prepare({ infoHash: IH, fileIdx: 9 })).toEqual({
      ok: false,
      reason: 'torrent-failed',
      retryable: false,
    });
  });

  it('direct URL: the URL itself', async () => {
    const { fake, prepare } = await setup();
    const result = await prepare({ url: MOVIE });
    expect(result).toMatchObject({
      ok: true,
      handle: { engineId: 'home', sid: 'E000000000000000000001' },
      status: {
        phase: 'ready',
        info: { height: 1080, width: 1920, codec: 'h264', durationSec: 120 },
      },
    });
    expect(fake.masterRequests[0]?.mediaURL).toBe(MOVIE);
    expect(fake.requests.find((r) => r.path === '/hlsv2/probe')?.query.mediaURL).toBe(MOVIE);
  });

  it('URL with proxyHeaders: wrapped in /proxy/stream with h_ and r_ parameters', async () => {
    const { fake, prepare } = await setup();
    const result = await prepare({
      url: MOVIE,
      behaviorHints: {
        proxyHeaders: { request: { 'User-Agent': 'Agent/1.0' }, response: { 'X-A': 'b c' } },
      },
    });
    expect(result.ok).toBe(true);
    const mediaURL = new URL(fake.masterRequests[0]?.mediaURL ?? '');
    expect(mediaURL.origin + mediaURL.pathname).toBe(`${SELF}/proxy/stream`);
    expect(Buffer.from(mediaURL.searchParams.get('d') ?? '', 'base64url').toString()).toBe(MOVIE);
    expect(mediaURL.searchParams.get('h_User-Agent')).toBe('Agent/1.0');
    expect(mediaURL.searchParams.get('r_X-A')).toBe('b c');
  });

  it('VOD HLS URL with a duration plays', async () => {
    const { fake, prepare } = await setup();
    const url = 'https://media.example/vod/index.m3u8';
    expect((await prepare({ url })).ok).toBe(true);
    expect(fake.masterRequests[0]?.mediaURL).toBe(url);
  });

  it('live HLS (probe duration 0) → live, not retryable', async () => {
    const { fake, prepare } = await setup();
    const url = 'https://media.example/live/index.m3u8';
    fake.setProbe(url, 'zero-duration');
    expect(await prepare({ url })).toEqual({ ok: false, reason: 'live', retryable: false });
    expect(fake.masterRequests).toEqual([]);
  });

  it('ytId: the engine-local /yt URL', async () => {
    const { fake, prepare } = await setup();
    expect((await prepare({ ytId: 'abc_DEF-123' })).ok).toBe(true);
    expect(fake.masterRequests[0]?.mediaURL).toBe(`${SELF}/yt/abc_DEF-123`);
  });

  it.each([
    ['externalUrl', { externalUrl: 'https://site.example/watch' }, 'external'],
    ['an archive', { rarUrls: [['https://files.example/a.rar']] }, 'unsupported'],
    [
      'NZB',
      { nzbUrl: 'https://files.example/a.nzb', servers: ['nntps://news.example'] },
      'unsupported',
    ],
    ['a player frame', { playerFrameUrl: 'https://site.example/embed' }, 'unsupported'],
    ['a non-http URL', { url: 'ftp://files.example/movie.mkv' }, 'unsupported'],
    ['no source at all', { name: 'nothing' }, 'unsupported'],
  ])('%s → unplayable without calling the engine', async (_name, stream, reason) => {
    const { fake, prepare } = await setup();
    expect(await prepare(stream)).toEqual({ ok: false, reason, retryable: false });
    expect(fake.requests).toEqual([]);
  });
});

describe('probe rules', () => {
  it('a failed probe → probe-failed (retryable only for torrents)', async () => {
    const { fake, prepare } = await setup();
    fake.setProbe(MOVIE, 'failing');
    expect(await prepare({ url: MOVIE })).toEqual({
      ok: false,
      reason: 'probe-failed',
      retryable: false,
    });
    fake.setProbe(`${SELF}/${IH}/1`, 'failing');
    expect(await prepare({ infoHash: IH, fileIdx: 1 })).toEqual({
      ok: false,
      reason: 'probe-failed',
      retryable: true,
    });
  });

  it('logs the engine detail when a source is unplayable, and nothing secret', async () => {
    const { fake, prepare, log } = await setup({ fake: { proxyPassword: PROXY_PASSWORD } });
    fake.setProbe(MOVIE, 'failing');
    await prepare({ url: MOVIE });
    fake.setProbe(`${SELF}/${IH}/1`, 'failing');
    await prepare({ infoHash: IH, fileIdx: 1 });
    // A proxyHeaders source refused by the engine (no password reaches it here).
    await prepare({
      url: 'https://media.example/dl/SECRETTOKEN123/x.mkv',
      behaviorHints: { proxyHeaders: { request: { Authorization: 'Bearer SECRETHEADER456' } } },
    });
    const lines = log.lines().filter((l) => l.msg === 'stream unplayable');
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatchObject({
      reason: 'probe-failed',
      phase: 'probing',
      engineStatus: 500,
      engineError: 'ffprobe: exit status 1',
    });
    expect(lines[1]).toMatchObject({
      reason: 'probe-failed',
      retryable: true,
      torrentPeers: 7,
      torrentDownloadSpeed: 2_500_000,
    });
    const text = log.text();
    for (const secret of [
      PROXY_PASSWORD,
      'SECRETTOKEN123',
      'SECRETHEADER456',
      'media.example',
      'api_password',
      'h_Authorization',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('safeEngineText drops URLs and token-like text and cuts to 200 characters', () => {
    const out = safeEngineText(
      `Get "https://debrid.example/dl/SECRETTOKEN123/f.mkv?api_password=hunter2": dial failed\napi_password=hunter2 ${'x'.repeat(300)}`,
    );
    expect(out).not.toContain('debrid');
    expect(out).not.toContain('SECRETTOKEN123');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('dial failed');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('zero duration on a non-playlist → probe-failed', async () => {
    const { fake, prepare } = await setup();
    fake.setProbe(MOVIE, { duration: 0, formatName: 'matroska,webm', streams: [] });
    expect(await prepare({ url: MOVIE })).toMatchObject({ ok: false, reason: 'probe-failed' });
  });

  it('a real height above liveMaxHeight → needs-prepare', async () => {
    const { fake, prepare } = await setup();
    fake.setProbe(MOVIE, 'hdr-4k');
    const statuses: EngineStatus[] = [];
    expect(await prepare({ url: MOVIE }, { onStatus: (s) => statuses.push(s) })).toEqual({
      ok: false,
      reason: 'needs-prepare',
      retryable: false,
    });
    expect(statuses.at(-1)).toEqual({ phase: 'failed' });
    expect(fake.masterRequests).toEqual([]);
  });

  it('a 4K source plays on an engine whose liveMaxHeight allows it; HDR is reported', async () => {
    const { fake, prepare } = await setup({ caps: { liveMaxHeight: 2160 } });
    fake.setProbe(MOVIE, 'hdr-4k');
    expect(await prepare({ url: MOVIE })).toMatchObject({
      ok: true,
      status: { info: { height: 2160, hdr: 'hdr10', codec: 'hevc' } },
    });
  });
});

describe('engine availability', () => {
  it('an unreachable engine → engine-offline, retryable', async () => {
    const { fake, prepare } = await setup();
    fake.online = false;
    expect(await prepare({ url: MOVIE })).toEqual({
      ok: false,
      reason: 'engine-offline',
      retryable: true,
    });
  });

  it('an engine the health check saw offline fails fast', async () => {
    const { fake, registry, prepare } = await setup();
    registry.recordHealth('home', { online: false, lastSeen: null, checkedAt: 1 });
    expect(await prepare({ url: MOVIE })).toMatchObject({ reason: 'engine-offline' });
    expect(fake.requests).toEqual([]);
  });

  it('an unknown engine → engine-offline, not retryable', async () => {
    const { module } = await setup();
    expect(
      await module.prepare({
        engineId: 'nope',
        sessionKey: 'ps_one',
        stream: { url: MOVIE } as PrepareRequest['stream'],
        mode: 'play',
      }),
    ).toEqual({ ok: false, reason: 'engine-offline', retryable: false });
  });

  it("mode 'full' is phase 4 and rejects", async () => {
    const { prepare } = await setup();
    await expect(prepare({ url: MOVIE }, { mode: 'full' })).rejects.toThrow(/phase 4/);
  });
});

describe('engine session identity and quality', () => {
  it('the same session key, stream and quality reuse one engine session', async () => {
    const { db, prepare } = await setup();
    const a = await prepare({ url: MOVIE });
    const b = await prepare({ url: MOVIE });
    expect(a.ok && b.ok && a.handle.sid === b.handle.sid).toBe(true);
    expect(await db.selectFrom('engine_sessions').selectAll().execute()).toHaveLength(1);
  });

  it('another session key or stream gets a new engine session', async () => {
    const { prepare } = await setup();
    const a = await prepare({ url: MOVIE });
    const b = await prepare({ url: MOVIE }, { sessionKey: 'ps_two' });
    const c = await prepare({ url: 'https://media.example/other.mkv' });
    const sids = [a, b, c].map((r) => (r.ok ? r.handle.sid : ''));
    expect(new Set(sids).size).toBe(3);
  });

  it('quality goes on the creating master request and into the handle; it splits engine sessions', async () => {
    const { fake, prepare } = await setup();
    const q720 = await prepare({ url: MOVIE }, { quality: { maxHeight: 720, bitrate: 4_000_000 } });
    const q480 = await prepare({ url: MOVIE }, { quality: { maxHeight: 480 } });
    const none = await prepare({ url: MOVIE });
    expect(q720).toMatchObject({
      ok: true,
      handle: { quality: { maxHeight: 720, bitrate: 4_000_000 } },
    });
    expect(none.ok && none.handle.quality).toBe(undefined);
    const sids = [q720, q480, none].map((r) => (r.ok ? r.handle.sid : ''));
    expect(new Set(sids).size).toBe(3);
    expect(fake.masterRequests.map((m) => m.overrides)).toEqual([
      { maxHeight: '720', bitrate: '4000000' },
      { maxHeight: '480' },
      {},
    ]);
    expect(fake.sessions.get(sids[0] ?? '')?.applied).toEqual({
      maxHeight: 720,
      bitrate: 4_000_000,
    });
  });

  it('an engine without sessionOverrides gets no overrides; quality is not part of identity', async () => {
    const { fake, prepare, log } = await setup({ caps: { sessionOverrides: false } });
    const a = await prepare({ url: MOVIE }, { quality: { maxHeight: 720 } });
    const b = await prepare({ url: MOVIE }, { quality: { maxHeight: 480 } });
    expect(a.ok && a.handle.quality).toBe(undefined);
    expect(a.ok && b.ok && a.handle.sid === b.handle.sid).toBe(true);
    expect(fake.masterRequests.every((m) => Object.keys(m.overrides).length === 0)).toBe(true);
    expect(log.text()).toContain('requested quality not applied');
  });

  it('an engine with its gate off ignores the overrides (the fake records them)', async () => {
    const { fake, prepare } = await setup({ fake: { overrides: false } });
    const result = await prepare({ url: MOVIE }, { quality: { maxHeight: 720 } });
    expect(result.ok).toBe(true);
    expect(fake.masterRequests[0]?.overrides).toEqual({ maxHeight: '720' });
    expect(fake.sessions.get(result.ok ? result.handle.sid : '')?.applied).toEqual({});
  });

  it('an out-of-range override is refused with 400 → engine-error', async () => {
    const { fake, prepare } = await setup({ sessionTtlSec: 10 });
    expect(await prepare({ url: MOVIE })).toEqual({
      ok: false,
      reason: 'engine-error',
      retryable: false,
    });
    expect(fake.masterRequests[0]).toMatchObject({ status: 400, overrides: { ttl: '10' } });
    expect(fake.sessions.size).toBe(0);
  });

  it('concurrent identical prepares share one attempt', async () => {
    const { fake, prepare } = await setup();
    const [a, b] = await Promise.all([prepare({ url: MOVIE }), prepare({ url: MOVIE })]);
    expect(a).toEqual(b);
    expect(fake.masterRequests).toHaveLength(1);
  });
});

describe('warm start', () => {
  it('fetches seg0–seg2 of a muxed session in the background', async () => {
    const { fake, module, prepare } = await setup();
    const result = await prepare({ url: MOVIE });
    await module.idle();
    const sid = result.ok ? result.handle.sid : '';
    expect(fake.segmentsCompleted).toEqual([`${sid}/seg0.ts`, `${sid}/seg1.ts`, `${sid}/seg2.ts`]);
  });

  it('a multi-audio session warms video and the default audio rendition', async () => {
    const { fake, module, prepare } = await setup();
    fake.setProbe(MOVIE, 'multi-audio');
    const result = await prepare({ url: MOVIE });
    await module.idle();
    const sid = result.ok ? result.handle.sid : '';
    expect([...fake.segmentsCompleted].sort()).toEqual(
      ['a1seg0.ts', 'a1seg1.ts', 'a1seg2.ts', 'seg0.ts', 'seg1.ts', 'seg2.ts'].map(
        (f) => `${sid}/${f}`,
      ),
    );
  });

  it('can be turned off', async () => {
    const { fake, module, prepare } = await setup({ warmSegments: 0 });
    await prepare({ url: MOVIE });
    await module.idle();
    expect(fake.segmentsCompleted).toEqual([]);
  });

  it('parses playlists the way server-go writes them', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="sub0.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",DEFAULT=NO,AUTOSELECT=NO,URI="audio0.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="por",DEFAULT=YES,AUTOSELECT=YES,URI="audio1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"',
      'video.m3u8',
    ].join('\n');
    expect(warmPlaylists(master)).toEqual(['audio1.m3u8', 'video.m3u8']);
    expect(warmPlaylists('#EXTM3U\nhttps://elsewhere.example/x.m3u8\n')).toEqual([]);
    expect(firstSegments('#EXTM3U\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nseg1.ts\n', 1)).toEqual([
      'seg0.ts',
    ]);
  });
});

describe('status', () => {
  it('torrent sessions report peers and download speed from stats', async () => {
    const { module, prepare, clock } = await setup();
    const result = await prepare({ infoHash: IH, fileIdx: 1 });
    if (!result.ok) throw new Error('prepare failed');
    expect(await module.refreshStatus(result.handle)).toMatchObject({
      phase: 'ready',
      peers: 7,
      downloadSpeed: 2_500_000,
    });
    // status() is synchronous and refreshes in the background when stale.
    clock.advance(10_000);
    expect(module.status(result.handle)).toMatchObject({ phase: 'ready', peers: 7 });
    await module.idle();
  });

  it('an unknown handle reads as ready', async () => {
    const { module } = await setup();
    expect(module.status({ engineId: 'home', sid: 'x' })).toEqual({ phase: 'ready' });
  });
});

describe('release', () => {
  it('deletes the engine session on an engine with DELETE, and forgets it', async () => {
    const { db, fake, module, prepare } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    await module.idle();
    await module.release(result.handle);
    expect(fake.deletes).toEqual([result.handle.sid]);
    expect(fake.sessions.size).toBe(0);
    expect(await db.selectFrom('engine_sessions').selectAll().execute()).toEqual([]);
    await expect(module.fetchMedia(result.handle, 'master.m3u8')).rejects.toBeInstanceOf(
      EngineSessionNotFoundError,
    );
  });

  it('is a logged no-op on an engine without DELETE', async () => {
    const { fake, module, prepare, log } = await setup({ fake: { supportsDelete: false } });
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    await module.release(result.handle);
    expect(fake.deletes).toEqual([]);
    expect(fake.sessions.size).toBe(1);
    expect(log.text()).toContain('no-op release');
    // The capability probe ran once, with an id the engine rejects as invalid.
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('a session already gone on the engine releases cleanly', async () => {
    const { fake, module, prepare } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    fake.restart();
    await expect(module.release(result.handle)).resolves.toBeUndefined();
  });

  it('rejects while the engine is unreachable, keeping the session for a retry', async () => {
    const { db, fake, module, prepare } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    fake.online = false;
    await expect(module.release(result.handle)).rejects.toThrow();
    const rows = await db.selectFrom('engine_sessions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ release_attempts: 1 });
    expect(rows[0]?.release_pending_since).not.toBeNull();
  });

  it('retries a pending release with backoff until the engine deletes it', async () => {
    const { db, fake, module, prepare, clock, registry } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    await module.idle();
    const row = () =>
      db
        .selectFrom('engine_sessions')
        .select(['release_attempts', 'release_next_at'])
        .executeTakeFirst();
    fake.online = false;
    await expect(module.release(result.handle)).rejects.toThrow();
    const t0 = clock();
    expect(await row()).toEqual({ release_attempts: 1, release_next_at: t0 + 60_000 });

    // Not due yet: nothing is tried.
    expect(await module.retryReleases()).toEqual({ released: 0, pending: 1 });
    expect((await row())?.release_attempts).toBe(1);
    // Due, still offline: the wait doubles.
    clock.advance(60_000);
    expect(await module.retryReleases()).toEqual({ released: 0, pending: 1 });
    expect(await row()).toEqual({ release_attempts: 2, release_next_at: clock() + 120_000 });
    // The health check sees the engine offline: skipped without an attempt.
    clock.advance(120_000);
    registry.recordHealth('home', { online: false, lastSeen: null, checkedAt: clock() });
    expect(await module.retryReleases()).toEqual({ released: 0, pending: 1 });
    expect((await row())?.release_attempts).toBe(2);

    // Back online: deleted on the engine, and the row (with its mediaURL) goes.
    fake.online = true;
    registry.recordHealth('home', { online: true, lastSeen: clock(), checkedAt: clock() });
    expect(await module.retryReleases()).toEqual({ released: 1, pending: 0 });
    expect(fake.deletes).toEqual([result.handle.sid]);
    expect(fake.sessions.size).toBe(0);
    expect(await row()).toBeUndefined();
  });

  it('the backoff is capped', async () => {
    const { db, fake, prepare, clock, registry } = await setup();
    const module = new ServerGoEngineModule({
      db,
      registry,
      logger: memoryLogger().logger,
      clock,
      ids: sequentialIds(),
      releaseRetryBaseMs: 1_000,
      releaseRetryMaxMs: 3_000,
    });
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    fake.online = false;
    await expect(module.release(result.handle)).rejects.toThrow();
    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = await db
        .selectFrom('engine_sessions')
        .select('release_next_at')
        .executeTakeFirstOrThrow();
      waits.push((before.release_next_at ?? 0) - clock());
      clock.advance(before.release_next_at === null ? 0 : before.release_next_at - clock());
      await module.retryReleases();
    }
    expect(waits).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('a session gone from the engine (404) ends a pending release', async () => {
    const { db, fake, module, prepare, clock } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    fake.online = false;
    await expect(module.release(result.handle)).rejects.toThrow();
    fake.restart(); // no persistence: the session is gone
    fake.online = true;
    clock.advance(60_000);
    expect(await module.retryReleases()).toEqual({ released: 1, pending: 0 });
    expect(fake.deletes).toEqual([]);
    expect(await db.selectFrom('engine_sessions').selectAll().execute()).toEqual([]);
  });

  it('pending releases survive a Multitap restart (they are in the database)', async () => {
    const { fake, module, make, prepare, clock } = await setup();
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    fake.online = false;
    await expect(module.release(result.handle)).rejects.toThrow();
    fake.online = true;
    clock.advance(60_000);
    expect(await make().retryReleases()).toEqual({ released: 1, pending: 0 });
    expect(fake.deletes).toEqual([result.handle.sid]);
  });
});

describe('configuration', () => {
  it('MULTITAP_ENGINE_SESSION_TTL_MS becomes the per-session ttl; the sweep interval and health backoff pace release retries', () => {
    expect(engineModuleConfig(loadConfig({}))).toEqual({
      releaseRetryBaseMs: 60_000,
      releaseRetryMaxMs: 60_000,
    });
    expect(
      engineModuleConfig(
        loadConfig({
          MULTITAP_ENGINE_SESSION_TTL_MS: '172800000',
          MULTITAP_RETENTION_SWEEP_MS: '5000',
        }),
      ),
    ).toEqual({ sessionTtlSec: 172_800, releaseRetryBaseMs: 5_000, releaseRetryMaxMs: 60_000 });
    expect(
      engineModuleConfig(loadConfig({ MULTITAP_ENGINE_SESSION_TTL_MS: '3600500' })).sessionTtlSec,
    ).toBe(3601);
  });
});

describe('proxy password (okf:architecture/secrets-classes-and-engine-password)', () => {
  it('a proxyHeaders source plays with the password: api_password on probe and master, never stored', async () => {
    const { db, fake, prepare, module } = await setup({
      proxyPassword: PROXY_PASSWORD,
      fake: { proxyPassword: PROXY_PASSWORD },
    });
    const result = await prepare(PROXIED);
    expect(result.ok).toBe(true);
    const probed = new URL(
      fake.requests.find((r) => r.path === '/hlsv2/probe')?.query.mediaURL ?? '',
    );
    expect(probed.searchParams.get('api_password')).toBe(PROXY_PASSWORD);
    const master = new URL(fake.masterRequests[0]?.mediaURL ?? '');
    expect(master.searchParams.get('api_password')).toBe(PROXY_PASSWORD);
    expect(master.searchParams.get('h_User-Agent')).toBe('Agent/1.0');
    expect(fake.proxyRefusals).toEqual([]);
    // The stored mediaURL has no password: it is added on the way out.
    const rows = await db.selectFrom('engine_sessions').select('media_url').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.media_url).not.toContain(PROXY_PASSWORD);
    expect(rows[0]?.media_url).not.toContain('api_password');
    await module.idle();
  });

  it('fails without the password (probe-failed), with a hint in the log', async () => {
    const { fake, prepare, log } = await setup({ fake: { proxyPassword: PROXY_PASSWORD } });
    const result = await prepare(PROXIED);
    expect(result).toEqual({ ok: false, reason: 'probe-failed', retryable: false });
    expect(fake.proxyRefusals.length).toBeGreaterThan(0);
    expect(fake.masterRequests).toEqual([]);
    expect(log.text()).toContain('proxyPassword');
    expect(log.lines().find((l) => l.proxyPasswordSet !== undefined)).toMatchObject({
      proxyPasswordSet: false,
    });
  });

  it('fails with a wrong password, and works once it is corrected (no restart)', async () => {
    const { db, fake, prepare } = await setup({
      proxyPassword: 'wrong',
      fake: { proxyPassword: PROXY_PASSWORD },
    });
    expect((await prepare(PROXIED)).ok).toBe(false);
    expect(fake.proxyRefusals.length).toBeGreaterThan(0);
    await db
      .updateTable('engines')
      .set({ proxy_password: PROXY_PASSWORD })
      .where('id', '=', 'home')
      .execute();
    expect((await prepare(PROXIED)).ok).toBe(true);
  });

  it('self-heal sends the current password; other sources never get it', async () => {
    const { db, fake, prepare, module } = await setup({
      proxyPassword: PROXY_PASSWORD,
      fake: { proxyPassword: PROXY_PASSWORD },
      warmSegments: 0,
    });
    const result = await prepare(PROXIED);
    if (!result.ok) throw new Error('prepare failed');
    // Rotated: the engine and Multitap's copy change together.
    const rotated = 'FAKErotatedPASSWORD-9876543210';
    fake.options.proxyPassword = rotated;
    await db
      .updateTable('engines')
      .set({ proxy_password: rotated })
      .where('id', '=', 'home')
      .execute();
    fake.evict(result.handle.sid);
    expect((await module.fetchMedia(result.handle, 'master.m3u8')).status).toBe(200);
    const last = new URL(fake.mastersFor(result.handle.sid).at(-1)?.mediaURL ?? '');
    expect(last.searchParams.get('api_password')).toBe(rotated);

    expect((await prepare({ url: MOVIE }, { sessionKey: 'ps_two' })).ok).toBe(true);
    expect(fake.masterRequests.at(-1)?.mediaURL).toBe(MOVIE);
    const torrent = await prepare({ infoHash: IH, fileIdx: 1 }, { sessionKey: 'ps_three' });
    expect(torrent.ok).toBe(true);
    expect(fake.masterRequests.at(-1)?.mediaURL).toBe(`${SELF}/${IH}/1`);
  });

  it('never logs the password, at info or at debug', async () => {
    for (const logLevel of ['info', 'debug'] as const) {
      const { fake, prepare, module, log } = await setup({
        proxyPassword: PROXY_PASSWORD,
        fake: { proxyPassword: PROXY_PASSWORD },
        logLevel,
      });
      const result = await prepare(PROXIED);
      if (!result.ok) throw new Error('prepare failed');
      await module.idle();
      fake.online = false;
      await expect(module.release(result.handle)).rejects.toThrow();
      fake.online = true;
      await module.fetchMedia(result.handle, 'master.m3u8').catch(() => undefined);
      expect(log.text()).not.toContain(PROXY_PASSWORD);
    }
  });

  it('never appears in an error message', async () => {
    const { fake, prepare, module } = await setup({
      proxyPassword: PROXY_PASSWORD,
      fake: { proxyPassword: PROXY_PASSWORD },
    });
    const result = await prepare(PROXIED);
    if (!result.ok) throw new Error('prepare failed');
    fake.online = false;
    const errors: unknown[] = [];
    await module.fetchMedia(result.handle, 'master.m3u8').catch((err: unknown) => errors.push(err));
    await module.release(result.handle).catch((err: unknown) => errors.push(err));
    expect(errors).toHaveLength(2);
    for (const err of errors) {
      const e = err as Error & { cause?: unknown };
      expect(`${e.message} ${e.stack ?? ''} ${String(e.cause)}`).not.toContain(PROXY_PASSWORD);
      expect(JSON.stringify(err)).not.toContain(PROXY_PASSWORD);
    }
  });
});

describe('fetchMedia and self-heal', () => {
  it('serves playlists and segments; relative URIs resolve under the session', async () => {
    const { module, prepare } = await setup({ warmSegments: 0 });
    const result = await prepare({ url: MOVIE });
    if (!result.ok) throw new Error('prepare failed');
    const master = await (await module.fetchMedia(result.handle, 'master.m3u8')).text();
    expect(master).toContain('\nplaylist.m3u8\n');
    const playlist = await (await module.fetchMedia(result.handle, 'playlist.m3u8')).text();
    expect(playlist).toContain('\nseg0.ts\n');
    const seg = await module.fetchMedia(result.handle, 'seg0.ts');
    expect(seg.status).toBe(200);
    expect(new Uint8Array(await seg.arrayBuffer())[0]).toBe(0x47);
  });

  it('after eviction segments 404 until the master is requested again, with the same overrides', async () => {
    const { fake, module, prepare } = await setup({ warmSegments: 0 });
    const result = await prepare({ url: MOVIE }, { quality: { maxHeight: 720 } });
    if (!result.ok) throw new Error('prepare failed');
    fake.evict(result.handle.sid);
    expect((await module.fetchMedia(result.handle, 'seg3.ts')).status).toBe(404);
    expect((await module.fetchMedia(result.handle, 'master.m3u8')).status).toBe(200);
    expect((await module.fetchMedia(result.handle, 'seg3.ts')).status).toBe(200);
    expect(
      fake.mastersFor(result.handle.sid).map((m) => [m.created, m.overrides, m.mediaURL]),
    ).toEqual([
      [true, { maxHeight: '720' }, MOVIE],
      [true, { maxHeight: '720' }, MOVIE],
    ]);
  });

  it('recovers after an engine restart and after a Multitap restart (state from the database)', async () => {
    const { fake, make, prepare } = await setup({ warmSegments: 0 });
    const result = await prepare({ infoHash: IH, fileIdx: 1 });
    if (!result.ok) throw new Error('prepare failed');
    fake.restart();
    const fresh = make(); // a new Multitap process: nothing in memory
    expect((await fresh.fetchMedia(result.handle, 'seg0.ts')).status).toBe(404);
    expect((await fresh.fetchMedia(result.handle, 'master.m3u8')).status).toBe(200);
    expect(fake.mastersFor(result.handle.sid).at(-1)?.mediaURL).toBe(`${SELF}/${IH}/1`);
    expect((await fresh.fetchMedia(result.handle, 'seg0.ts')).status).toBe(200);
  });

  it('a handle Multitap never prepared is not found', async () => {
    const { module } = await setup();
    await expect(
      module.fetchMedia({ engineId: 'home', sid: 'E000000000000000000099' }, 'master.m3u8'),
    ).rejects.toBeInstanceOf(EngineSessionNotFoundError);
  });
});

describe('secrets', () => {
  it('never logs a mediaURL at info', async () => {
    const { fake, prepare, module, log } = await setup();
    fake.setProbe(MOVIE, 'hdr-4k');
    await prepare({ url: MOVIE });
    await prepare({
      url: 'https://media.example/secret-token/movie.mkv',
      behaviorHints: { proxyHeaders: { request: { Authorization: 'Bearer s3cr3t' } } },
    });
    await module.idle();
    expect(log.text()).not.toContain('media.example');
    expect(log.text()).not.toContain('s3cr3t');
  });
});
