/**
 * Live HLS (okf:architecture/media-gateway "Live", okf:process/phase-4-core-checklist item 9): a live
 * source played through the engine's HLS proxy, from the session to the bytes
 * a player gets. The fake engine stands in for the proxy and the origin.
 */
import type { Stream } from '@multitap/addon-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerGoEngineModule } from '../src/engines/engine-module.ts';
import {
  LIVE_FILE,
  LiveSealer,
  liveEndpoint,
  parseEngineProxyUrl,
  rewriteLivePlaylist,
} from '../src/engines/live.ts';
import { createMediaApp } from '../src/gateway/app.ts';
import { createGatewayServices } from '../src/gateway/services.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { putEngine } from '../src/engines/index.ts';
import { HOME_ENGINE, PUBLIC_DNS_GUARD } from './engine-fixture.ts';
import { httpStream, MOVIE, sessionRig, type Rig, type RigOptions } from './session-setup.ts';

const SECRET = 'live-test-secret-0123456789abcdefgh';
const CHANNEL = 'https://live.example/ch/master.m3u8';
const PASSWORD = 'engine-proxy-password';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.service.stop();
    await rig.settle();
    await rig.db.destroy();
  }
});

async function setup(options: RigOptions = {}) {
  const r = await sessionRig({
    ...options,
    env: { MULTITAP_MEDIA_TOKEN_SECRET: SECRET, ...options.env },
  });
  rigs.push(r);
  r.fake.addLive(CHANNEL);
  r.fake.setProbe(CHANNEL, 'zero-duration');
  const gateway = createGatewayServices({
    config: r.config,
    sessions: r.service,
    repo: r.repo,
    subtitles: {
      list: () => Promise.resolve({ subtitles: [], addons: [] }),
      file: () => Promise.reject(new Error('no subtitles')),
    },
    clock: r.clock,
    logger: r.log.logger,
  });
  const mediaFor = (module: ServerGoEngineModule) =>
    createMediaApp({
      config: r.config,
      logger: r.log.logger,
      services: { sessions: r.service, engines: module, gateway, metrics: r.metrics },
    });
  const media = mediaFor(r.module);

  /** A session on `stream`, resolved; its id. */
  const session = async (stream: Stream, extra: Record<string, unknown> = {}) => {
    const { session: created } = await r.service.create({
      item: MOVIE,
      source: { key: r.list(stream) },
      ...extra,
    });
    await r.settle();
    return created.id;
  };
  /** A token for the session and a `GET` under it. */
  const viewer = async (id: string, subject = 'tv', app = media) => {
    const record = await r.repo.get(id);
    const { token } = await gateway.tokens.mint(id, subject, record?.tokenEpoch ?? 0, 3_600_000);
    return (file: string, headers: Record<string, string> = {}) =>
      app.request(`/media/${token}/${file}`, { headers });
  };
  return { r, gateway, media, mediaFor, session, viewer };
}

const liveStream = { url: CHANNEL, name: 'Fake', title: 'Channel' } as Stream;

/** The URI lines and `URI="…"` attributes of a playlist. */
function uris(playlist: string): string[] {
  const out: string[] = [];
  for (const line of playlist.split('\n')) {
    if (line === '') continue;
    if (!line.startsWith('#')) out.push(line);
    else for (const m of line.matchAll(/URI="([^"]*)"/g)) out.push(m[1] ?? '');
  }
  return out;
}

describe('engine proxy URLs and sealed names', () => {
  it('reads the three proxy endpoints and nothing else', () => {
    const d = b64('https://cdn.example/a/b.m3u8?t=1');
    expect(parseEngineProxyUrl(`http://127.0.0.1:11470/proxy/hls/manifest.m3u8?d=${d}`)).toEqual({
      dest: 'https://cdn.example/a/b.m3u8?t=1',
      ext: 'm3u8',
    });
    expect(
      parseEngineProxyUrl(`https://engine.lan/proxy/stream/segment.M4S?d=${d}&api_password=x`),
    ).toMatchObject({ ext: 'm4s' });
    expect(parseEngineProxyUrl(`/proxy/stream?d=${d}`)).toMatchObject({ ext: 'bin' });
    expect(parseEngineProxyUrl('/proxy/stream?d=https%3A%2F%2Fcdn.example%2Fk')).toEqual({
      dest: 'https://cdn.example/k',
      ext: 'bin',
    });
    for (const bad of [
      'https://cdn.example/a/b.m3u8',
      `/proxy/ip?d=${d}`,
      `/proxy/stream/segment.m3u8?d=${d}`,
      `/proxy/stream/segment.bin?d=${d}`,
      '/proxy/stream',
      `/proxy/stream?d=${b64('file:///etc/passwd')}`,
      `/hlsv2/x/master.m3u8?d=${d}`,
    ]) {
      expect(parseEngineProxyUrl(bad)).toBeUndefined();
    }
    expect(liveEndpoint('m3u8')).toBe('/proxy/hls/manifest.m3u8');
    expect(liveEndpoint('bin')).toBe('/proxy/stream');
    expect(liveEndpoint('ts')).toBe('/proxy/stream/segment.ts');
  });

  it('seals a target for one session, the same way every time, and opens nothing else', () => {
    const sealer = new LiveSealer(SECRET);
    const target = { dest: 'https://cdn.example/live/seg1.ts?token=abc', ext: 'ts' };
    const name = sealer.seal('SID1', target);
    expect(`live/${name}`).toMatch(LIVE_FILE);
    expect(name).not.toContain('cdn');
    expect(sealer.seal('SID1', target)).toBe(name);
    expect(sealer.open('SID1', `live/${name}`)).toEqual(target);
    // Another process with the same secret opens it; a random or different key doesn't.
    expect(new LiveSealer(SECRET).open('SID1', `live/${name}`)).toEqual(target);
    expect(
      new LiveSealer('another-secret-0123456789abcdefgh').open('SID1', `live/${name}`),
    ).toBeUndefined();
    expect(new LiveSealer().open('SID1', `live/${name}`)).toBeUndefined();
    // Not under another session, as another kind of file, or changed.
    expect(sealer.open('SID2', `live/${name}`)).toBeUndefined();
    expect(sealer.open('SID1', `live/${name.replace(/\.ts$/, '.m3u8')}`)).toBeUndefined();
    const flipped = name.startsWith('A') ? `B${name.slice(1)}` : `A${name.slice(1)}`;
    expect(sealer.open('SID1', `live/${flipped}`)).toBeUndefined();
    expect(sealer.open('SID1', name)).toBeUndefined();
    expect(sealer.open('SID1', 'live/short.ts')).toBeUndefined();
  });

  it('rewrites every proxy URL and refuses a playlist with any other http URL', () => {
    const d = (url: string) =>
      `http://127.0.0.1:11470/proxy/stream/segment.ts?d=${b64(url)}&api_password=pw`;
    const playlist = [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1:11470/proxy/stream?d=${b64('https://o.example/k')}&api_password=pw",IV=0x01`,
      '#EXT-X-SESSION-DATA:DATA-ID="x",URI="data:text/plain,hi"',
      '#EXTINF:4.000,',
      d('https://o.example/1.ts'),
      '',
    ].join('\r\n');
    const out = rewriteLivePlaylist(playlist, (t) => `N(${t.ext}:${t.dest})`);
    expect(out?.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="N(bin:https://o.example/k)",IV=0x01',
      '#EXT-X-SESSION-DATA:DATA-ID="x",URI="data:text/plain,hi"',
      '#EXTINF:4.000,',
      'N(ts:https://o.example/1.ts)',
      '',
    ]);
    const name = () => 'x';
    expect(rewriteLivePlaylist(`#EXTM3U\nhttps://o.example/raw.ts\n`, name)).toBeUndefined();
    expect(rewriteLivePlaylist(`#EXTM3U\nrelative/seg.ts\n`, name)).toBeUndefined();
    expect(
      rewriteLivePlaylist(`#EXTM3U\n#EXT-X-MAP:URI="https://o.example/init.mp4"\n`, name),
    ).toBeUndefined();
    expect(rewriteLivePlaylist('<html>not a playlist</html>', name)).toBeUndefined();
  });
});

describe('a live session', () => {
  it('is ready without a transcode: direct delivery, no engine HLS session', async () => {
    const { r, session } = await setup();
    const id = await session(liveStream);
    const view = await r.service.get(id);
    expect(view).toMatchObject({
      status: 'ready',
      live: true,
      delivery: 'direct',
      mediaEntry: 'master.m3u8',
    });
    expect(view?.quality).toBeUndefined();
    expect(view?.tracks).toBeUndefined();
    expect(r.fake.masterRequests).toHaveLength(0);
    expect(r.fake.sessions.size).toBe(0);
    expect(await r.db.selectFrom('engine_sessions').select(['live', 'prepared']).execute()).toEqual(
      [{ live: 1, prepared: 0 }],
    );
    expect(r.fake.liveRequests.map((q) => [q.path, q.dest])).toEqual([
      ['/proxy/hls/manifest.m3u8', CHANNEL],
    ]);

    // Released: only the row goes; the engine holds nothing to delete.
    await r.service.release(id, 'request');
    expect(r.fake.deletes).toEqual([]);
    expect(await r.db.selectFrom('engine_sessions').select('sid').execute()).toEqual([]);
  });

  it('is refused where it cannot be proxied: an asked-for transcode, a preparation, an engine without the proxy', async () => {
    const { r, session } = await setup({ fake: { supportsPrepare: true } });
    for (const extra of [{ delivery: 'transcode' }, { mode: 'full' }]) {
      const id = await session(liveStream, extra);
      expect(await r.service.get(id)).toMatchObject({ status: 'failed', failureReason: 'live' });
    }
    const old = await setup({ fake: { supportsLiveProxy: false } });
    const id = await old.session(liveStream);
    expect(await old.r.service.get(id)).toMatchObject({ status: 'failed', failureReason: 'live' });

    // A playlist the origin doesn't serve, and a private host.
    const gone = await setup();
    gone.r.fake.setProbe('https://live.example/gone/master.m3u8', 'zero-duration');
    const missing = await gone.session({
      ...liveStream,
      url: 'https://live.example/gone/master.m3u8',
    });
    expect((await gone.r.service.get(missing))?.failureReason).toBe('probe-failed');
    gone.r.fake.setProbe('http://192.168.1.20/ch/master.m3u8', 'zero-duration');
    const lan = await gone.session({ ...liveStream, url: 'http://192.168.1.20/ch/master.m3u8' });
    expect((await gone.r.service.get(lan))?.failureReason).toBe('unsupported');
  });

  it('a source that is not live still transcodes', async () => {
    const { r, session } = await setup();
    const id = await session(httpStream('movie'));
    const view = await r.service.get(id);
    expect(view).toMatchObject({
      status: 'ready',
      delivery: 'transcode',
      mediaEntry: 'master.m3u8',
    });
    expect(view?.live).toBeUndefined();
  });
});

describe('through the gateway', () => {
  it('serves the playlists with sealed names and passes the segments through', async () => {
    // With `proxyHeaders` the probe reads the engine's own proxy URL: every probe here is live.
    const { r, session, viewer } = await setup({
      fake: { proxyPassword: PASSWORD, defaultProbe: 'zero-duration' },
    });
    await putEngine(r.db, 'home', {
      ...HOME_ENGINE,
      address: 'http://engine.test:11470',
      proxyPassword: PASSWORD,
    });
    const id = await session({
      ...liveStream,
      behaviorHints: { proxyHeaders: { request: { Referer: 'https://site.example/' } } },
    } as unknown as Stream);
    expect((await r.service.get(id))?.status).toBe('ready');
    const get = await viewer(id);

    const master = await get('master.m3u8');
    expect(master.status).toBe(200);
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(master.headers.get('cache-control')).toBe('no-store');
    const masterText = await master.text();
    const [audio, variant] = uris(masterText);
    expect(uris(masterText)).toHaveLength(2);
    expect(variant).toMatch(/^live\/[A-Za-z0-9_-]+\.m3u8$/);
    expect(audio).toMatch(/^live\/[A-Za-z0-9_-]+\.m3u8$/);
    expect(masterText).toContain('RESOLUTION=1920x1080');

    const playlist = await get(variant ?? '');
    expect(playlist.status).toBe(200);
    const text = await playlist.text();
    expect(text).not.toContain('#EXT-X-ENDLIST');
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:100');
    const segments = uris(text);
    expect(segments).toHaveLength(3);
    // Relative to the playlist, which is itself under `live/`.
    for (const name of segments) expect(name).toMatch(/^[A-Za-z0-9_-]+\.ts$/);

    // Nothing of the origin, the engine or its password reaches the player.
    for (const body of [masterText, text]) {
      for (const secret of [
        'live.example',
        'origin-token',
        '127.0.0.1',
        'proxy',
        'api_password',
        PASSWORD,
        'site.example',
      ]) {
        expect(body).not.toContain(secret);
      }
    }

    const segment = await get(`live/${segments[0] ?? ''}`);
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    expect(new Uint8Array(await segment.arrayBuffer())).toEqual(
      r.fake.segmentBody('live', 'high/seg100.ts?sig=origin-token'),
    );
    const part = await get(`live/${segments[1] ?? ''}`, { Range: 'bytes=0-187' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-187/1880');
    expect((await part.arrayBuffer()).byteLength).toBe(188);
    // A range Multitap doesn't pass on is ignored: the whole file.
    expect((await get(`live/${segments[1] ?? ''}`, { Range: 'bytes=0-1,5-9' })).status).toBe(200);

    // Every engine request carried the headers and the password; the same names come back each time.
    expect(r.fake.proxyRefusals).toEqual([]);
    for (const q of r.fake.liveRequests)
      expect(q.headers).toEqual({ h_Referer: 'https://site.example/' });
    expect(r.fake.liveRequests.at(-2)).toMatchObject({
      path: '/proxy/stream/segment.ts',
      dest: 'https://live.example/ch/high/seg101.ts?sig=origin-token',
      range: 'bytes=0-187',
    });
    expect(uris(await (await get(variant ?? '')).text())).toEqual(segments);

    // The live edge moves: new names, the old ones still open.
    const channel = r.fake.live.get(CHANNEL);
    if (channel === undefined) throw new Error('no channel');
    channel.sequence = 101;
    const moved = uris(await (await get(variant ?? '')).text());
    expect(moved.slice(0, 2)).toEqual(segments.slice(1));
    expect(moved[2]).not.toBe(segments[2]);
  });

  it('serves a key, and tells telemetry and load apart from a transcode', async () => {
    const { r, gateway, session, viewer } = await setup();
    r.fake.addLive(CHANNEL, { encrypted: true });
    const id = await session(liveStream);
    const get = await viewer(id);
    const [, variant] = uris(await (await get('master.m3u8')).text());
    const text = await (await get(variant ?? '')).text();
    const [key, first] = uris(text);
    expect(key).toMatch(/^[A-Za-z0-9_-]+\.bin$/);
    expect(text).toContain('#EXT-X-KEY:METHOD=AES-128,URI="');
    const keyRes = await get(`live/${key ?? ''}`);
    expect(keyRes.status).toBe(200);
    expect(new Uint8Array(await keyRes.arrayBuffer())).toEqual(
      r.fake.segmentBody('live', 'high/key.bin'),
    );
    expect((await get(`live/${first ?? ''}`)).status).toBe(200);
    await r.settle();

    expect(gateway.viewers.list(id)).toMatchObject([{ subject: 'tv', lastFile: 'live/segment' }]);
    // Proxied, not transcoded: no engine load.
    expect(r.service.engineLoad('home')).toEqual({ resolving: 0, playing: 0 });
  });

  it('opens a name only under its own session, and nothing made up', async () => {
    const { r, session, viewer } = await setup();
    r.fake.addLive('https://live.example/two/master.m3u8');
    r.fake.setProbe('https://live.example/two/master.m3u8', 'zero-duration');
    const one = await session(liveStream);
    const two = await session({ ...liveStream, url: 'https://live.example/two/master.m3u8' });
    const getOne = await viewer(one);
    const getTwo = await viewer(two);
    const [, variant] = uris(await (await getOne('master.m3u8')).text());
    expect((await getOne(variant ?? '')).status).toBe(200);
    expect((await getTwo(variant ?? '')).status).toBe(404);
    expect((await getOne(`live/${'A'.repeat(60)}.ts`)).status).toBe(404);
    expect((await getOne('playlist.m3u8')).status).toBe(404);

    // A transcode session has no live files, whatever the name.
    const vod = await session(httpStream('movie'));
    const getVod = await viewer(vod);
    expect((await getVod(variant ?? '')).status).toBe(404);
    expect((await getVod('master.m3u8')).status).toBe(200);

    await r.service.release(one, 'request');
    expect((await getOne('master.m3u8')).status).toBe(410);
  });

  it('refuses a child on a private host without asking the engine', async () => {
    const { r, session, viewer } = await setup();
    r.fake.addLive(CHANNEL, { extraLine: 'http://192.168.1.10/admin.ts' });
    const id = await session(liveStream);
    const get = await viewer(id);
    const [, variant] = uris(await (await get('master.m3u8')).text());
    const names = uris(await (await get(variant ?? '')).text());
    expect(names).toHaveLength(4);
    const before = r.fake.liveRequests.length;
    expect((await get(`live/${names[3] ?? ''}`)).status).toBe(404);
    expect(r.fake.liveRequests).toHaveLength(before);
    expect(r.log.text()).toContain('live file refused');
    expect(r.log.text()).not.toContain('192.168.1.10');
  });

  it('answers 502 when the origin fails, and goes on after a restart of Multitap', async () => {
    const { r, mediaFor, session, viewer } = await setup();
    const id = await session(liveStream);
    const get = await viewer(id);
    const [, variant] = uris(await (await get('master.m3u8')).text());
    const names = uris(await (await get(variant ?? '')).text());

    // Another process: nothing in memory, the row and the secret are enough.
    const second = new ServerGoEngineModule({
      db: r.db,
      registry: r.registry,
      logger: r.log.logger,
      clock: r.clock,
      ids: sequentialIds(),
      privateHosts: PUBLIC_DNS_GUARD,
      liveSecret: SECRET,
    });
    const again = await viewer(id, 'phone', mediaFor(second));
    expect((await again(`live/${names[0] ?? ''}`)).status).toBe(200);
    expect(uris(await (await again(variant ?? '')).text())).toEqual(names);
    expect(await second.openSubHash({ engineId: 'home', sid: 'x' })).toBeUndefined();

    r.fake.live.delete(CHANNEL);
    expect((await get('master.m3u8')).status).toBe(502);
    expect((await get(`live/${names[0] ?? ''}`)).status).toBe(502);
  });
});
