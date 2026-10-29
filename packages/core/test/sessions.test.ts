/**
 * Playback sessions (phase 2 step 4): the repository, retention maths, the
 * session service against the fake engine (picked and auto-selected sources,
 * fallback, idempotency, quality, the 501s, release and retention), and the
 * events it emits. Injected clock, ids and sleep; no ffmpeg, no network.
 */
import { PlaybackSessionSchema, type MultitapEvent, type EventType } from '@multitap/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BITRATE_BY_HEIGHT } from '../src/config.ts';
import { PLAYBACK_SESSION_PUBLIC_COLUMNS } from '../src/db/schema.ts';
import { isDueForRelease, retentionDeadline } from '../src/sessions/retention.ts';
import {
  bitrateForHeight,
  capQuality,
  effectiveQuality,
  SessionError,
  type SessionService,
} from '../src/sessions/service.ts';
import { SqliteSessionRepository } from '../src/sessions/sqlite-repository.ts';
import { bearer, migratedMemoryDb } from './helpers.ts';
import {
  httpStream,
  IH_DEAD,
  IH_GOOD,
  MOVIE,
  sessionRig,
  torrentStream,
  type Rig,
} from './session-setup.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.service.stop();
    await rig.settle();
    await rig.db.destroy();
  }
});

async function rig(options?: Parameters<typeof sessionRig>[0]) {
  const r = await sessionRig(options);
  rigs.push(r);
  return r;
}

const types = (events: MultitapEvent[]) => events.map((e) => e.type);
const ofType = <T extends EventType>(events: MultitapEvent[], type: T) =>
  events.filter((e): e is Extract<MultitapEvent, { type: T }> => e.type === type);

async function expectSessionError(promise: Promise<unknown>, code: SessionError['code']) {
  await expect(promise).rejects.toBeInstanceOf(SessionError);
  await promise.catch((err: unknown) => {
    expect((err as SessionError).code).toBe(code);
  });
}

// ---- Retention maths ---------------------------------------------------------------------

describe('retention (okf:architecture/engine-retention)', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const cases: {
    name: string;
    retainUntil: number | null;
    lastAccess: number;
    deadline: number;
    due: boolean;
  }[] = [
    {
      name: 'idle only, recent access',
      retainUntil: null,
      lastAccess: now - 30 * MIN,
      deadline: now + 30 * MIN,
      due: false,
    },
    {
      name: 'idle only, exactly an hour',
      retainUntil: null,
      lastAccess: now - HOUR,
      deadline: now,
      due: true,
    },
    {
      name: 'idle only, long ago',
      retainUntil: null,
      lastAccess: now - 5 * HOUR,
      deadline: now - 4 * HOUR,
      due: true,
    },
    {
      name: 'retainUntil later than idle',
      retainUntil: now + 6 * HOUR,
      lastAccess: now - 5 * HOUR,
      deadline: now + 6 * HOUR,
      due: false,
    },
    {
      name: 'retainUntil passed, idle not',
      retainUntil: now - HOUR,
      lastAccess: now - 10 * MIN,
      deadline: now + 50 * MIN,
      due: false,
    },
    {
      name: 'both passed',
      retainUntil: now - 1,
      lastAccess: now - 2 * HOUR,
      deadline: now - 1,
      due: true,
    },
  ];

  it.each(cases)('$name', ({ retainUntil, lastAccess, deadline, due }) => {
    expect(retentionDeadline({ retainUntil, lastAccess }, HOUR)).toBe(deadline);
    expect(isDueForRelease({ retainUntil, lastAccess }, HOUR, now)).toBe(due);
  });

  it('the repository query agrees with the rule', async () => {
    const db = await migratedMemoryDb();
    const repo = new SqliteSessionRepository(db);
    for (const [i, c] of cases.entries()) {
      await repo.create(
        {
          id: `ps_${String(i)}`,
          key: null,
          item: MOVIE,
          source: { auto: true },
          identity: null,
          candidates: null,
          engineId: 'home',
          delivery: 'transcode',
          mode: 'play',
          highRes: 'off',
          requestedQuality: null,
          readyBy: null,
          retainUntil: c.retainUntil,
        },
        c.lastAccess,
      );
    }
    const due = await repo.listDueForRelease(now, HOUR);
    expect(due.map((r) => r.id).sort()).toEqual(
      cases
        .map((c, i) => (c.due ? `ps_${String(i)}` : undefined))
        .filter((id) => id !== undefined)
        .sort(),
    );
    await db.destroy();
  });
});

describe('capQuality (okf:architecture/rendition-and-bandwidth)', () => {
  it.each([
    { quality: undefined, out: undefined },
    { quality: {}, out: undefined },
    { quality: { maxHeight: 720 }, out: { maxHeight: 720 } },
    { quality: { maxHeight: 2160 }, out: { maxHeight: 1080 } },
    { quality: { bitrate: 6_000_000 }, out: { bitrate: 6_000_000 } },
    { quality: { bitrate: 50_000_000 }, out: { bitrate: 20_000_000 } },
    {
      quality: { maxHeight: 1440, bitrate: 90_000_000 },
      out: { maxHeight: 1080, bitrate: 20_000_000 },
    },
  ])('$quality → $out', ({ quality, out }) => {
    expect(capQuality(quality, 1080, 20_000_000)).toEqual(out);
  });
});

// ---- Repository ----------------------------------------------------------------------------

describe('SqliteSessionRepository', () => {
  it('keeps the raw stream out of records and returns it only through getStream', async () => {
    const r = await rig();
    const record = await r.repo.create(
      {
        id: 'ps_x',
        key: 'room:1',
        item: { ...MOVIE, videoId: MOVIE.id },
        source: { key: 'k1' },
        identity: 'abc',
        candidates: null,
        engineId: 'home',
        delivery: 'transcode',
        mode: 'play',
        highRes: 'off',
        requestedQuality: { maxHeight: 720 },
        readyBy: null,
        retainUntil: null,
      },
      r.clock(),
    );
    expect(record).toMatchObject({ status: 'resolving', tokenEpoch: 0, key: 'room:1' });
    const secret = httpStream('SECRET-TOKEN');
    await r.repo.setChosen(
      'ps_x',
      {
        chosenKey: 'k1',
        stream: secret,
        engineId: 'home',
        sid: 'sid1',
        quality: null,
        tracks: { audio: [{ index: 0, lang: 'eng', default: true }], subtitles: [] },
        audioTrack: null,
        bingeGroup: 'fake|1080p',
      },
      r.clock(),
    );
    const read = await r.repo.get('ps_x');
    expect(read).toMatchObject({
      tracks: { audio: [{ index: 0, lang: 'eng', default: true }], subtitles: [] },
      audioTrack: null,
      bingeGroup: 'fake|1080p',
    });
    expect(JSON.stringify(read)).not.toContain('SECRET-TOKEN');
    expect(Object.keys(read ?? {})).not.toContain('stream');
    expect(await r.repo.getStream('ps_x')).toEqual(secret);
    expect(PLAYBACK_SESSION_PUBLIC_COLUMNS).not.toContain('stream_json');

    expect(await r.repo.findOpenByIdentity('abc')).toMatchObject({ id: 'ps_x' });
    await r.repo.update('ps_x', { status: 'failed' }, r.clock());
    expect(await r.repo.findOpenByIdentity('abc')).toBeUndefined();

    expect(await r.repo.bumpTokenEpoch('ps_x', r.clock())).toBe(1);
    expect(await r.repo.bumpTokenEpoch('ps_x', r.clock())).toBe(2);
    expect(await r.repo.bumpTokenEpoch('ps_nope', r.clock())).toBeUndefined();

    await r.repo.touch('ps_x', r.clock() + 10);
    await r.repo.touch('ps_x', r.clock() + 5); // never moves back
    expect((await r.repo.get('ps_x'))?.lastAccess).toBe(r.clock() + 10);
  });

  it('keeps revocations until they end, extending but never shortening', async () => {
    const r = await rig();
    await r.repo.create(
      {
        id: 'ps_r',
        key: null,
        item: MOVIE,
        source: { auto: true },
        identity: null,
        candidates: null,
        engineId: 'home',
        delivery: 'transcode',
        mode: 'play',
        highRes: 'off',
        requestedQuality: null,
        readyBy: null,
        retainUntil: null,
      },
      0,
    );
    await r.repo.revokeSubject({ sessionId: 'ps_r', subject: 'a', until: 100 });
    await r.repo.revokeSubject({ sessionId: 'ps_r', subject: 'a', until: 50 });
    await r.repo.revokeSubject({ sessionId: 'ps_r', subject: 'b', until: 200 });
    expect(await r.repo.listRevocations(99)).toEqual([
      { sessionId: 'ps_r', subject: 'a', until: 100 },
      { sessionId: 'ps_r', subject: 'b', until: 200 },
    ]);
    expect(await r.repo.purgeRevocations(150)).toBe(1);
    expect(await r.repo.listRevocations(0)).toEqual([
      { sessionId: 'ps_r', subject: 'b', until: 200 },
    ]);
  });
});

// ---- Service: picked source ------------------------------------------------------------------

describe('picked source (okf:decision/auto-select-and-fallback standard path)', () => {
  it('resolves to ready with the engine handle and emits status, ready', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const { session, created } = await r.service.create({ item: MOVIE, source: { key } });
    expect(created).toBe(true);
    expect(PlaybackSessionSchema.parse(session)).toMatchObject({
      status: 'resolving',
      delivery: 'transcode',
      mediaEntry: 'master.m3u8',
      mode: 'play',
      highRes: 'off',
      engineId: 'home',
      tokenEpoch: 0,
    });
    await r.settle();

    const ready = await r.service.get(session.id);
    expect(ready).toMatchObject({ status: 'ready', chosen: key, progress: { phase: 'ready' } });
    expect(types(r.events)).toEqual([
      'session.status', // resolving
      'session.status', // trying the candidate
      'session.status', // probing
      'session.status', // engine ready
      'session.ready',
    ]);
    const readyEvent = ofType(r.events, 'session.ready')[0];
    expect(readyEvent?.data.session.status).toBe('ready');
    expect(r.fake.masterRequests).toHaveLength(1);

    const target = await r.service.mediaTarget(session.id);
    expect(target.kind).toBe('ready');
    if (target.kind === 'ready') {
      expect(target.handle).toEqual({ engineId: 'home', sid: expect.any(String) as string });
      const res = await r.module.fetchMedia(target.handle, 'master.m3u8');
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    // No secret anywhere in the API view or the logs.
    expect(JSON.stringify(ready)).not.toContain('media.example');
    expect(r.log.text()).not.toContain('media.example');
  });

  it('fails without fallback when the source is unplayable', async () => {
    const r = await rig();
    const stream = httpStream('dead');
    r.fake.setProbe((stream as { url: string }).url, 'failing');
    const key = r.list(stream);
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'probe-failed',
    });
    expect(ofType(r.events, 'session.failed')[0]?.data).toEqual({
      sessionId: session.id,
      reason: 'probe-failed',
    });
    expect(await r.service.mediaTarget(session.id)).toMatchObject({ kind: 'not-ready' });
  });

  it('rejects an expired key (409), another item’s key, and an unknown engine', async () => {
    const r = await rig();
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { key: 'never-listed' } }),
      'candidate-expired',
    );
    const key = r.list(httpStream('good'));
    r.clock.advance(r.config.selection.streamStoreTtlMs + 1);
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { key } }),
      'candidate-expired',
    );
    const other = r.list(httpStream('other'), { type: 'movie', id: 'tt0000002' });
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { key: other } }),
      'candidate-mismatch',
    );
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { auto: true }, engine: 'nope' }),
      'unknown-engine',
    );
  });

  it('uses the candidate’s engine affinity over the request', async () => {
    const r = await rig();
    const stream = httpStream('local');
    const key = r.list(stream);
    const stored = r.streams.get(key);
    if (stored === undefined) throw new Error('not listed');
    r.streams.put(key, { ...stored, requiresEngine: 'nope' });
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { key }, engine: 'home' }),
      'unknown-engine',
    );
  });
});

// ---- Service: auto-select --------------------------------------------------------------------

describe('auto-select (okf:decision/auto-select-and-fallback)', () => {
  it('falls back past a dead source and stores the candidates', async () => {
    const r = await rig();
    const dead = httpStream('dead');
    r.fake.setProbe((dead as { url: string }).url, 'failing');
    const [first, second] = r.auto(dead, httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    const done = await r.service.get(session.id);
    expect(done).toMatchObject({ status: 'ready', chosen: second?.key });
    expect(done?.candidates?.map((c) => c.key)).toEqual([first?.key, second?.key]);
    const chosen = ofType(r.events, 'session.status')
      .map((e) => e.data.chosen)
      .filter((c) => c !== undefined);
    expect(new Set(chosen)).toEqual(new Set([first?.key, second?.key]));
  });

  it('fails with no-candidates when nothing is playable now', async () => {
    const r = await rig();
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'no-candidates',
    });
    expect(ofType(r.events, 'session.failed')[0]?.data).toMatchObject({ attempts: 0 });
  });

  it('stops after MULTITAP_AUTO_SELECT_MAX_ATTEMPTS', async () => {
    const r = await rig({ env: { MULTITAP_AUTO_SELECT_MAX_ATTEMPTS: '2' } });
    const streams = ['a', 'b', 'c'].map((n) => httpStream(`dead-${n}`));
    for (const s of streams) r.fake.setProbe((s as { url: string }).url, 'failing');
    r.auto(...streams, httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'attempts-exhausted',
    });
    expect(ofType(r.events, 'session.failed')[0]?.data.attempts).toBe(2);
    expect(r.fake.requests.filter((q) => q.path === '/hlsv2/probe')).toHaveLength(2);
  });

  it('retries a failed torrent once after the negative-probe window', async () => {
    const r = await rig();
    const http = httpStream('dead');
    r.fake.setProbe((http as { url: string }).url, 'failing');
    const [torrent] = r.auto(torrentStream(IH_DEAD), http);
    // The torrent finds peers while Multitap waits.
    r.onSleep = () => {
      r.fake.addTorrent(IH_DEAD, { files: [{ name: 'Movie.2026.1080p.mkv', length: 9 }] });
    };
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(r.sleeps).toEqual([r.config.selection.autoRetryAfterMs]);
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'ready',
      chosen: torrent?.key,
    });
    expect(r.fake.creates.filter((c) => c.infoHash === IH_DEAD)).toHaveLength(2);
  });

  it('gives up when the retried torrent fails again', async () => {
    const r = await rig();
    r.auto(torrentStream(IH_DEAD));
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(r.sleeps).toHaveLength(1);
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'candidates-exhausted',
    });
  });

  it('skips the other torrents once the engine is at its torrent cap, but tries URL sources', async () => {
    const r = await rig();
    const http = httpStream('good');
    const [, , url] = r.auto(torrentStream(IH_GOOD), torrentStream(IH_DEAD), http);
    // The create and its one retry are both refused.
    r.fake.busyCreates = 2;
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({ status: 'ready', chosen: url?.key });
    expect(r.fake.creates.map((c) => c.infoHash)).toEqual([IH_GOOD, IH_GOOD]);
    expect(r.sleeps).toEqual([]);
  });

  it('fails with engine-busy when only torrents remain at the cap', async () => {
    const r = await rig();
    r.auto(torrentStream(IH_GOOD), torrentStream(IH_DEAD));
    r.fake.busyCreates = 2;
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'engine-busy',
    });
    expect(r.fake.creates).toHaveLength(2);
  });

  it('stops at once when the engine is offline', async () => {
    const r = await rig();
    r.fake.online = false;
    r.auto(httpStream('a'), httpStream('b'));
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'engine-offline',
    });
    expect(ofType(r.events, 'session.failed')[0]?.data.attempts).toBe(1);
  });
});

// ---- Idempotency, quality, 501s ----------------------------------------------------------------

describe('idempotency (okf:architecture/playback-session)', () => {
  it('returns the open session for the same key, item, source, delivery and quality', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const request = { key: 'room:abc', item: MOVIE, source: { key } };
    // Concurrent creates: the second waits for the first.
    const [a, b] = await Promise.all([r.service.create(request), r.service.create(request)]);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, session: { id: a.session.id } });

    const variants: Parameters<SessionService['create']>[0][] = [
      { ...request, key: 'room:other' },
      { ...request, delivery: 'transcode' }, // 'auto' and 'transcode' differ, as requested
      { ...request, quality: { maxHeight: 720 } },
      { ...request, source: { auto: true } },
      { ...request, item: { ...MOVIE, videoId: MOVIE.id } },
    ];
    for (const variant of variants) {
      if ('key' in variant.source) r.list(httpStream('good'), variant.item);
      const out = await r.service.create(variant);
      expect(out.created).toBe(true);
      expect(out.session.id).not.toBe(a.session.id);
    }
    // A capped quality matches the exact one.
    const capped = await r.service.create({ ...request, quality: { maxHeight: 2160 } });
    const exact = await r.service.create({ ...request, quality: { maxHeight: 1080 } });
    expect(exact).toMatchObject({ created: false, session: { id: capped.session.id } });

    // Without a key, every create is new.
    const one = await r.service.create({ item: MOVIE, source: { key } });
    const two = await r.service.create({ item: MOVIE, source: { key } });
    expect(one.session.id).not.toBe(two.session.id);

    // A failed or released session is not reused.
    await r.settle();
    await r.service.release(a.session.id, 'request');
    const again = await r.service.create(request);
    expect(again.created).toBe(true);
  });
});

describe('quality (okf:architecture/rendition-and-bandwidth)', () => {
  it('caps the request and shows what the engine applied', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key },
      quality: { maxHeight: 2160, bitrate: 90_000_000 },
    });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'ready',
      quality: { maxHeight: 1080, bitrate: 20_000_000 },
    });
    expect(r.fake.masterRequests[0]?.overrides).toMatchObject({
      maxHeight: '1080',
      bitrate: '20000000',
    });
  });

  it('leaves quality absent on an engine without sessionOverrides', async () => {
    const r = await rig({ caps: { sessionOverrides: false } });
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key },
      quality: { maxHeight: 720 },
    });
    await r.settle();
    const done = await r.service.get(session.id);
    expect(done?.status).toBe('ready');
    expect(done?.quality).toBeUndefined();
    expect(r.fake.masterRequests[0]?.overrides).toEqual({});
    expect(r.log.text()).toContain('sessionOverrides');
  });
});

describe('bitrate from height (okf:architecture/rendition-and-bandwidth)', () => {
  const sessions = { maxBitrate: 20_000_000, bitrateByHeight: [...DEFAULT_BITRATE_BY_HEIGHT] };
  const caps = { liveMaxHeight: 1080 };

  it.each([
    { height: 144, out: 600_000 },
    { height: 360, out: 1_000_000 },
    { height: 540, out: 2_000_000 },
    { height: 720, out: 3_000_000 },
    { height: 1080, out: 6_000_000 },
    { height: 4320, out: 16_000_000 },
  ])('$height → $out', ({ height, out }) => {
    expect(bitrateForHeight(height, DEFAULT_BITRATE_BY_HEIGHT)).toBe(out);
  });

  it('derives from the capped height, never above MULTITAP_SESSION_MAX_BITRATE or defaultBitrate', () => {
    expect(effectiveQuality({ maxHeight: 2160 }, caps, sessions)).toEqual({
      maxHeight: 1080,
      bitrate: 6_000_000,
    });
    expect(
      effectiveQuality({ maxHeight: 1080 }, caps, { ...sessions, maxBitrate: 4_000_000 }),
    ).toEqual({ maxHeight: 1080, bitrate: 4_000_000 });
    expect(
      effectiveQuality({ maxHeight: 1080 }, { ...caps, defaultBitrate: 5_000_000 }, sessions),
    ).toEqual({ maxHeight: 1080, bitrate: 5_000_000 });
    // An explicit bitrate wins, capped at MULTITAP_SESSION_MAX_BITRATE only (no hidden 20M).
    expect(
      effectiveQuality(
        { maxHeight: 720, bitrate: 45_000_000 },
        { ...caps, defaultBitrate: 5_000_000 },
        { ...sessions, maxBitrate: 50_000_000 },
      ),
    ).toEqual({ maxHeight: 720, bitrate: 45_000_000 });
    // No height, or the table off: nothing derived.
    expect(effectiveQuality({ bitrate: 2_000_000 }, caps, sessions)).toEqual({
      bitrate: 2_000_000,
    });
    expect(effectiveQuality(undefined, caps, sessions)).toBeUndefined();
    expect(
      effectiveQuality({ maxHeight: 720 }, caps, { ...sessions, bitrateByHeight: [] }),
    ).toEqual({ maxHeight: 720 });
  });

  it('sends the derived bitrate, shows it on the session, and treats it as the identity', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const request = { key: 'room:q', item: MOVIE, source: { key }, quality: { maxHeight: 720 } };
    const first = await r.service.create(request);
    await r.settle();
    expect(await r.service.get(first.session.id)).toMatchObject({
      status: 'ready',
      quality: { maxHeight: 720, bitrate: 3_000_000 },
    });
    expect(r.fake.masterRequests[0]?.overrides).toMatchObject({
      maxHeight: '720',
      bitrate: '3000000',
    });
    // The same effective quality, asked for explicitly: the same session.
    const explicit = await r.service.create({
      ...request,
      quality: { maxHeight: 720, bitrate: 3_000_000 },
    });
    expect(explicit).toMatchObject({ created: false, session: { id: first.session.id } });
  });

  it('follows MULTITAP_SESSION_BITRATE_BY_HEIGHT and a raised MULTITAP_SESSION_MAX_BITRATE', async () => {
    const r = await rig({
      env: {
        MULTITAP_SESSION_BITRATE_BY_HEIGHT: '720=2.5M,1080=40M',
        MULTITAP_SESSION_MAX_BITRATE: '50M',
      },
    });
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key },
      quality: { maxHeight: 1080 },
    });
    await r.settle();
    expect((await r.service.get(session.id))?.quality).toEqual({
      maxHeight: 1080,
      bitrate: 40_000_000,
    });
  });
});

describe('auto-select attempt timeout (okf:decision/auto-select-and-fallback)', () => {
  const IH_STALL = '3333333333333333333333333333333333333333';

  it('abandons a stalled torrent after MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS and plays the next', async () => {
    const r = await rig();
    r.fake.addTorrent(IH_STALL, {
      files: [{ name: 'Movie.2026.1080p.mkv', length: 9 }],
      stallMetadata: true,
    });
    const [, good] = r.auto(torrentStream(IH_STALL), httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await vi.waitFor(() => {
      expect(r.attemptTimers).toHaveLength(1);
    });
    expect(r.attemptTimers[0]?.ms).toBe(45_000);
    r.attemptTimers[0]?.fire();
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({ status: 'ready', chosen: good?.key });
    // The metadata wait was aborted on the engine, not left running.
    expect(r.fake.createsAborted).toEqual([IH_STALL]);
    expect(r.log.text()).toContain('candidate timed out');
    expect(r.attemptTimers).toHaveLength(0);
  });

  it('releases an engine session that a timed-out attempt created anyway', async () => {
    const r = await rig();
    let open: () => void = () => undefined;
    r.fake.masterHold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = httpStream('slow');
    r.auto(slow);
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await vi.waitFor(() => {
      expect(r.fake.requests.some((q) => q.path.endsWith('/master.m3u8'))).toBe(true);
    });
    r.attemptTimers[0]?.fire();
    // The engine answers after Multitap gave up.
    r.fake.masterHold = undefined;
    open();
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'candidates-exhausted',
    });
    expect(r.fake.sessions.size).toBe(0);
  });

  it('never limits a picked source, and 0 turns the limit off', async () => {
    const r = await rig();
    const picked = await r.service.create({
      item: MOVIE,
      source: { key: r.list(httpStream('a')) },
    });
    await r.settle();
    expect((await r.service.get(picked.session.id))?.status).toBe('ready');

    const off = await rig({ env: { MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS: '0' } });
    off.auto(httpStream('b'));
    const auto = await off.service.create({ item: MOVIE, source: { auto: true } });
    await off.settle();
    expect((await off.service.get(auto.session.id))?.status).toBe('ready');
    expect(r.attemptTimers).toHaveLength(0);
    expect(off.attemptTimers).toHaveLength(0);
  });
});

describe('engine admission (okf:architecture/engine-session-lifecycle)', () => {
  async function playing(r: Rig, name: string) {
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key: r.list(httpStream(name)) },
    });
    await r.settle();
    await r.service.touch(session.id, 'segment');
    return session.id;
  }

  it('counts resolving and recently playing sessions, and warns past liveConcurrency', async () => {
    const r = await rig({ caps: { liveConcurrency: 1 } });
    const a = await playing(r, 'a');
    expect(r.service.engineLoad('home')).toEqual({ resolving: 0, playing: 1 });
    expect(r.log.text()).not.toContain('live concurrency');
    const b = await r.service.create({ item: MOVIE, source: { key: r.list(httpStream('b')) } });
    expect(b.created).toBe(true);
    expect(r.log.text()).toContain('engine at its live concurrency');
    await r.settle();
    expect(await r.metrics.metrics()).toMatch(
      /multitap_engine_load_sessions\{engine_id="home"\} 1/,
    );
    expect(await r.metrics.metrics()).toMatch(
      /multitap_engine_live_concurrency\{engine_id="home"\} 1/,
    );
    // Idle past the window: no longer counted.
    r.clock.advance(r.config.engines.loadWindowMs + 1);
    expect(r.service.engineLoad('home').playing).toBe(0);
    // Released: gone at once.
    await r.service.touch(a, 'segment');
    await r.service.release(a, 'request');
    expect(r.service.engineLoad('home').playing).toBe(0);
  });

  it('reject answers 503 with Retry-After, except for an idempotent match', async () => {
    const r = await rig({
      caps: { liveConcurrency: 1 },
      env: { MULTITAP_ENGINE_ADMISSION: 'reject' },
    });
    const key = r.list(httpStream('a'));
    const request = { key: 'room:a', item: MOVIE, source: { key } };
    const first = await r.service.create(request);
    await r.settle();
    await r.service.touch(first.session.id, 'segment');
    // The same session again is no new load.
    expect(await r.service.create(request)).toMatchObject({ created: false });

    const err = await r.service
      .create({ item: MOVIE, source: { key: r.list(httpStream('b')) } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect(err).toMatchObject({ code: 'engine-busy', retryAfterSec: 60 });

    const res = await r.app.request('/v1/sessions', {
      method: 'POST',
      headers: { ...bearer(await r.keyFor('client')), 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: MOVIE, source: { key: r.list(httpStream('c')) } }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('off neither warns nor refuses', async () => {
    const r = await rig({
      caps: { liveConcurrency: 0 },
      env: { MULTITAP_ENGINE_ADMISSION: 'off' },
    });
    await playing(r, 'a');
    await r.service.create({ item: MOVIE, source: { key: r.list(httpStream('b')) } });
    expect(r.log.text()).not.toContain('live concurrency');
  });
});

describe('not built yet (501)', () => {
  it.each([
    { mode: 'full' as const },
    { readyBy: '2026-10-01T20:00:00.000Z' },
    { delivery: 'direct' as const },
    { delivery: 'remux' as const },
  ])('%o', async (extra) => {
    const r = await rig();
    await expectSessionError(
      r.service.create({ item: MOVIE, source: { auto: true }, ...extra }),
      'not-implemented',
    );
  });

  it('PATCH readyBy', async () => {
    const r = await rig();
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await expectSessionError(
      r.service.update(session.id, { readyBy: '2026-10-01T20:00:00.000Z' }),
      'not-implemented',
    );
  });
});

// ---- Release and retention -----------------------------------------------------------------------

describe('release and retention (okf:architecture/engine-retention)', () => {
  it('DELETE releases the engine session; the session answers released and 410 on PATCH', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    const changes: string[] = [];
    r.service.onChange((record) => changes.push(record.status));
    const released = await r.service.release(session.id, 'request');
    expect(released).toMatchObject({
      status: 'released',
      releasedAt: expect.any(String) as string,
    });
    expect(r.fake.deletes).toHaveLength(1);
    expect(changes).toEqual(['released']);
    expect(ofType(r.events, 'session.released')[0]?.data).toEqual({
      sessionId: session.id,
      reason: 'request',
    });
    expect(await r.service.mediaTarget(session.id)).toMatchObject({ kind: 'released' });
    await expectSessionError(r.service.update(session.id, { retainUntil: null }), 'released');
    // Again: nothing changes.
    await r.service.release(session.id, 'request');
    expect(r.fake.deletes).toHaveLength(1);
    expect(ofType(r.events, 'session.released')).toHaveLength(1);
  });

  it('a release while resolving leaves no engine session behind', async () => {
    const r = await rig({ fake: { segmentLatencyMs: 0 } });
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.service.release(session.id, 'request');
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({ status: 'released' });
    expect(ofType(r.events, 'session.ready')).toHaveLength(0);
    // Either the engine never created it, or Multitap deleted it again.
    expect(r.fake.sessions.size).toBe(0);
  });

  it('sweeps by max(retainUntil, lastAccess + idle), then purges released sessions', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const a = await r.service.create({ item: MOVIE, source: { key } });
    const b = await r.service.create({
      item: MOVIE,
      source: { key },
      retainUntil: new Date(r.clock() + 3 * HOUR).toISOString(),
    });
    await r.settle();

    r.clock.advance(30 * MIN);
    await r.service.touch(a.session.id); // media access
    r.clock.advance(59 * MIN);
    expect(await r.service.sweep()).toEqual({ released: 0, purged: 0 });
    r.clock.advance(2 * MIN);
    expect(await r.service.sweep()).toEqual({ released: 1, purged: 0 });
    expect((await r.service.getRecord(a.session.id))?.status).toBe('released');
    expect(ofType(r.events, 'session.released')[0]?.data.reason).toBe('retention');

    // b: retainUntil (3 h) outlasts its idle deadline (1 h).
    r.clock.advance(HOUR);
    expect((await r.service.sweep()).released).toBe(0);
    r.clock.advance(30 * MIN);
    expect((await r.service.sweep()).released).toBe(1);
    expect((await r.service.getRecord(b.session.id))?.status).toBe('released');

    r.clock.advance(r.config.sessions.releasedKeepMs + 1);
    expect((await r.service.sweep()).purged).toBe(2);
    expect(await r.service.get(a.session.id)).toBeUndefined();
    expect(await r.service.mediaTarget(a.session.id)).toEqual({ kind: 'not-found' });
  });

  it('PATCH retainUntil moves the deadline; null clears it', async () => {
    const r = await rig();
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    const until = new Date(r.clock() + 5 * HOUR).toISOString();
    expect(await r.service.update(session.id, { retainUntil: until })).toMatchObject({
      retainUntil: until,
    });
    r.clock.advance(2 * HOUR);
    expect((await r.service.sweep()).released).toBe(0);
    const cleared = await r.service.update(session.id, { retainUntil: null });
    expect(cleared.retainUntil).toBeUndefined();
    expect((await r.service.sweep()).released).toBe(1);
  });

  it('touch is throttled', async () => {
    const r = await rig();
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    const t0 = r.clock();
    r.clock.advance(1_000);
    await r.service.touch(session.id);
    r.clock.advance(1_000);
    await r.service.touch(session.id); // within the interval: not stored
    expect((await r.repo.get(session.id))?.lastAccess).toBe(t0 + 1_000);
  });

  it('start() fails sessions a previous run left resolving and serves ready ones', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const ready = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    await r.repo.create(
      {
        id: 'ps_stuck',
        key: null,
        item: MOVIE,
        source: { auto: true },
        identity: null,
        candidates: null,
        engineId: 'home',
        delivery: 'transcode',
        mode: 'play',
        highRes: 'off',
        requestedQuality: null,
        readyBy: null,
        retainUntil: null,
      },
      r.clock(),
    );
    await r.service.start();
    await r.settle();
    expect((await r.repo.get('ps_stuck'))?.failureReason).toBe('interrupted');
    expect((await r.service.mediaTarget(ready.session.id)).kind).toBe('ready');
  });

  it('bumpTokenEpoch notifies listeners', async () => {
    const r = await rig();
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    const epochs: number[] = [];
    r.service.onChange((record) => epochs.push(record.tokenEpoch));
    expect(await r.service.bumpTokenEpoch(session.id)).toBe(1);
    expect(epochs).toEqual([1]);
    expect(await r.service.bumpTokenEpoch('ps_nope')).toBeUndefined();
  });

  it('updates the multitap_sessions_status gauge', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    const text = await r.metrics.metrics();
    expect(text).toContain('multitap_sessions_status{status="ready"} 1');
    expect(text).toContain('multitap_sessions_status{status="resolving"} 0');
  });
});

describe('torrent sources', () => {
  it('plays a torrent picked by key', async () => {
    const r = await rig();
    const key = r.list(torrentStream(IH_GOOD));
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({ status: 'ready' });
    expect(ofType(r.events, 'session.status').map((e) => e.data.progress?.phase)).toContain(
      'metadata',
    );
  });
});

// ---- Engine release retries (okf:architecture/engine-retention, R27) -----------------------------------------------------

describe('engine release retries (okf:architecture/engine-retention)', () => {
  const pendingRows = (r: Rig) =>
    r.db
      .selectFrom('engine_sessions')
      .select(['sid', 'release_attempts'])
      .where('release_pending_since', 'is not', null)
      .execute();

  it('a release while the engine is offline is retried by the sweep once it is back', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    const sid = (await r.service.getRecord(session.id))?.sid;
    expect(sid).toBeTruthy();

    r.fake.online = false;
    expect(await r.service.release(session.id, 'request')).toMatchObject({ status: 'released' });
    expect(r.log.text()).toContain('the retention sweep retries it');
    expect(await pendingRows(r)).toEqual([{ sid, release_attempts: 1 }]);

    // Still offline at the next due sweep: still pending, and the engine still has it.
    r.clock.advance(r.config.sessions.sweepIntervalMs);
    await r.service.sweep();
    expect(await pendingRows(r)).toEqual([{ sid, release_attempts: 2 }]);
    expect(r.fake.sessions.has(sid ?? '')).toBe(true);

    // Back online: the next due sweep deletes it on the engine and drops the row.
    r.fake.online = true;
    r.clock.advance(2 * r.config.sessions.sweepIntervalMs);
    await r.service.sweep();
    expect(r.fake.deletes).toEqual([sid]);
    expect(r.fake.sessions.size).toBe(0);
    expect(await r.db.selectFrom('engine_sessions').selectAll().execute()).toEqual([]);
    expect(r.log.text()).toContain('engine session released on retry');
  });

  it('retention releases during an outage are retried too, and the playback session is purged as usual', async () => {
    const r = await rig();
    const key = r.list(httpStream('good'));
    await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    r.fake.online = false;
    r.clock.advance(HOUR + MIN);
    expect((await r.service.sweep()).released).toBe(1);
    expect(await pendingRows(r)).toHaveLength(1);
    r.fake.online = true;
    r.clock.advance(r.config.sessions.releasedKeepMs + 1);
    expect((await r.service.sweep()).purged).toBe(1);
    expect(r.fake.deletes).toHaveLength(1);
    expect(await pendingRows(r)).toEqual([]);
  });
});

// ---- The engine proxy password, end to end (okf:architecture/secrets-classes-and-engine-password, R24) --------------------------------------

describe('engine proxy password (okf:architecture/secrets-classes-and-engine-password)', () => {
  // A fake value only.
  const PASSWORD = 'FAKEproxyPASSWORD-0123456789';
  const proxied = () =>
    ({
      url: 'https://media.example/proxied.mkv',
      name: 'Fake',
      title: 'proxied 1080p',
      behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'Agent/1.0' } } },
    }) as unknown as ReturnType<typeof httpStream>;

  it('set through the API, a proxyHeaders source plays; the password never shows in responses or logs', async () => {
    const r = await rig({ fake: { proxyPassword: PASSWORD } });
    const admin = bearer(await r.keyFor('admin'));
    const current = await (
      await r.app.request('/v1/admin/engines/home', { headers: admin })
    ).json();
    const descriptor = { ...(current as Record<string, unknown>) };
    delete descriptor.online;
    delete descriptor.lastSeen;
    delete descriptor.proxyPasswordSet;
    const put = await r.app.request('/v1/admin/engines/home', {
      method: 'PUT',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...descriptor, proxyPassword: PASSWORD }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(PASSWORD);

    const { session } = await r.service.create({
      item: MOVIE,
      source: { key: r.list(proxied()) },
    });
    await r.settle();
    const read = await r.app.request(`/v1/sessions/${session.id}`, {
      headers: bearer(await r.keyFor('client')),
    });
    const text = await read.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'ready' });
    expect(text).not.toContain(PASSWORD);
    expect(r.fake.proxyRefusals).toEqual([]);
    expect(r.log.text()).not.toContain(PASSWORD);
  });

  it('without it the source fails with a coarse reason only', async () => {
    const r = await rig({ fake: { proxyPassword: PASSWORD } });
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key: r.list(proxied()) },
    });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'probe-failed',
    });
    expect(r.fake.proxyRefusals.length).toBeGreaterThan(0);
  });
});
