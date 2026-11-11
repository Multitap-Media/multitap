/**
 * Preparing ahead (okf:architecture/engine-prepare-ahead, okf:process/phase-4-core-checklist): `full` sessions
 * through the session service, the prepare jobs and the fake engine's
 * engine-side preparation. Passes are run by hand; the clock is manual.
 */
import type { EventType, MultitapEvent } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngineId, getEngine } from '../src/engines/index.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import {
  LATE_MIN_ELAPSED_MS,
  VERIFY_BEFORE_MS,
  preparedPct,
  prepareStartAt,
} from '../src/sessions/prepare-jobs.ts';
import { sessionIdentity } from '../src/sessions/identity.ts';
import { isDueForRelease } from '../src/sessions/retention.ts';
import { SessionError, SessionService } from '../src/sessions/service.ts';
import { bearer } from './helpers.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const LEAD = { upTo1080: HOUR, above1080: 36 * HOUR };

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.service.stop();
    await rig.settle();
    await rig.db.destroy();
  }
});

async function rig(options: Parameters<typeof sessionRig>[0] = {}) {
  const r = await sessionRig({
    ...options,
    fake: { supportsPrepare: true, ...options.fake },
  });
  rigs.push(r);
  return r;
}

const ofType = <T extends EventType>(events: MultitapEvent[], type: T) =>
  events.filter((e): e is Extract<MultitapEvent, { type: T }> => e.type === type);

const iso = (ms: number) => new Date(ms).toISOString();

/** A `full` session on a picked source, with its source chosen (status `preparing`, or what it ended in). */
async function full(r: Rig, name = 'movie', extra: { readyBy?: string; key?: string } = {}) {
  const { session } = await r.service.create({
    item: MOVIE,
    source: { key: r.list(httpStream(name)) },
    mode: 'full',
    ...extra,
  });
  await r.settle();
  return session.id;
}

/** One pass over the jobs, and whatever it set going. */
async function pass(r: Rig) {
  await r.service.prepareJobs.tick();
  await r.settle();
}

const view = async (r: Rig, id: string) => {
  const record = await r.repo.get(id);
  if (record === undefined) throw new Error('no such session');
  return record;
};

const jobOf = async (r: Rig, id: string) =>
  (await r.repo.listPrepareJobs()).find((job) => job.sessionId === id);

describe('lead time and progress', () => {
  it('starts at the lead time before readyBy, by the source height, and at once without one', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    expect(prepareStartAt(null, 2160, LEAD, now)).toBe(now);
    expect(prepareStartAt(now + 3 * HOUR, 1080, LEAD, now)).toBe(now + 2 * HOUR);
    expect(prepareStartAt(now + 3 * HOUR, null, LEAD, now)).toBe(now + 2 * HOUR);
    expect(prepareStartAt(now + 48 * HOUR, 2160, LEAD, now)).toBe(now + 12 * HOUR);
    // Too close to make the lead time, or already past: at once.
    expect(prepareStartAt(now + 3 * HOUR, 2160, LEAD, now)).toBe(now);
    expect(prepareStartAt(now - HOUR, 720, LEAD, now)).toBe(now);
  });

  it('reports the cached share', () => {
    expect(preparedPct({ state: 'running', totalSegments: 30, doneSegments: 10 })).toBe(33.3);
    expect(preparedPct({ state: 'scheduled', totalSegments: 0, doneSegments: 0 })).toBe(0);
    expect(preparedPct({ state: 'done', totalSegments: 0, doneSegments: 0 })).toBe(100);
    expect(preparedPct({ state: 'done', totalSegments: 30, doneSegments: 31 })).toBe(100);
  });
});

describe('a full session', () => {
  it('is preparing once its source is chosen and ready when the engine has finished', async () => {
    const r = await rig({ fake: { prepareSegmentsPerPoll: 10 } });
    const id = await full(r);
    const preparing = await r.service.get(id);
    expect(preparing).toMatchObject({
      mode: 'full',
      status: 'preparing',
      progress: { phase: 'preparing', preparedPct: 0 },
    });
    expect((await r.service.mediaTarget(id)).kind).toBe('not-ready');
    const sid = (await view(r, id)).sid ?? '';
    expect(r.fake.sessions.get(sid)?.prepare).toMatchObject({ state: 'running', audio: 'default' });
    // Nothing was warmed: the job transcodes from the start.
    expect(r.fake.fileRequests.size).toBe(0);
    expect(ofType(r.events, 'session.status').at(-1)?.data).toMatchObject({
      status: 'preparing',
      progress: { phase: 'preparing' },
    });

    await pass(r);
    await pass(r);
    expect((await r.service.get(id))?.progress).toEqual({ phase: 'preparing', preparedPct: 66.7 });
    expect(ofType(r.events, 'session.ready')).toHaveLength(0);

    r.clock.advance(2 * HOUR);
    await pass(r);
    const ready = await r.service.get(id);
    expect(ready).toMatchObject({
      status: 'ready',
      progress: { phase: 'prepared', preparedPct: 100 },
    });
    // Idle retention counts from the end of the preparation.
    expect(ready?.lastAccess).toBe(iso(r.clock()));
    expect((await r.service.mediaTarget(id)).kind).toBe('ready');
    expect(ofType(r.events, 'prepare.progress').map((e) => e.data.preparedPct)).toEqual([
      0, 33.3, 66.7,
    ]);
    expect(ofType(r.events, 'prepare.done').map((e) => e.data.sessionId)).toEqual([id]);
    expect(ofType(r.events, 'session.ready').at(-1)?.data.session.status).toBe('ready');
    expect(await jobOf(r, id)).toMatchObject({
      state: 'done',
      totalSegments: 30,
      doneSegments: 30,
    });
  });

  it('prepares every audio rendition with MULTITAP_PREPARE_ALL_AUDIO', async () => {
    const r = await rig({ env: { MULTITAP_PREPARE_ALL_AUDIO: 'true' } });
    r.fake.setProbe('https://media.example/multi.mkv', 'multi-audio');
    const id = await full(r, 'multi');
    await pass(r);
    expect(await jobOf(r, id)).toMatchObject({ state: 'done', audio: 'all', totalSegments: 45 });
  });

  it('takes a source too tall to play live', async () => {
    const r = await rig();
    r.fake.setProbe('https://media.example/uhd.mkv', 'hdr-4k');
    const { session } = await r.service.create({
      item: MOVIE,
      source: { key: r.list(httpStream('uhd')) },
    });
    await r.settle();
    expect((await r.service.get(session.id))?.failureReason).toBe('needs-prepare');
    const id = await full(r, 'uhd');
    expect(await jobOf(r, id)).toMatchObject({ height: 2160 });
    await pass(r);
    expect((await view(r, id)).status).toBe('ready');
  });

  it('fails on an engine without preparation', async () => {
    const r = await rig({ fake: { supportsPrepare: false } });
    const id = await full(r);
    expect(await r.service.get(id)).toMatchObject({
      status: 'failed',
      failureReason: 'prepare-unsupported',
    });
    expect(await jobOf(r, id)).toBeUndefined();
  });

  it('is not live load: admission never refuses it', async () => {
    const r = await rig({
      caps: { liveConcurrency: 0 },
      env: { MULTITAP_ENGINE_ADMISSION: 'reject' },
    });
    const id = await full(r);
    expect((await view(r, id)).status).toBe('preparing');
    await expect(
      r.service.create({ item: MOVIE, source: { key: r.list(httpStream('b')) } }),
    ).rejects.toMatchObject({ code: 'engine-busy' });
  });

  it('has its own identity, and readyBy needs it', async () => {
    const r = await rig();
    const source = { key: r.list(httpStream('movie')) };
    const play = await r.service.create({ key: 'tv', item: MOVIE, source });
    const prepared = await r.service.create({ key: 'tv', item: MOVIE, source, mode: 'full' });
    const again = await r.service.create({ key: 'tv', item: MOVIE, source, mode: 'full' });
    expect(prepared.created).toBe(true);
    expect(prepared.session.id).not.toBe(play.session.id);
    expect(again).toMatchObject({ created: false, session: { id: prepared.session.id } });
    // Identities stored before `mode` counted still match a `play` create.
    const parts = { key: 'tv', item: MOVIE, source, delivery: 'auto' as const, quality: undefined };
    expect(sessionIdentity({ ...parts, mode: 'play' })).toBe(sessionIdentity(parts));
    expect(sessionIdentity({ ...parts, mode: 'full' })).not.toBe(sessionIdentity(parts));

    const refused = r.service.create({ item: MOVIE, source, readyBy: iso(r.clock() + HOUR) });
    await expect(refused).rejects.toBeInstanceOf(SessionError);
    await expect(refused).rejects.toMatchObject({ code: 'ready-by-needs-full' });
    await expect(
      r.service.update(play.session.id, { readyBy: iso(r.clock() + HOUR) }),
    ).rejects.toMatchObject({ code: 'not-full' });
  });
});

describe('readyBy', () => {
  it('holds the job until its lead time, and a patch moves or clears the deadline', async () => {
    const r = await rig();
    const readyBy = r.clock() + 5 * HOUR;
    const id = await full(r, 'movie', { readyBy: iso(readyBy) });
    expect(await r.service.get(id)).toMatchObject({ status: 'preparing', readyBy: iso(readyBy) });
    expect(await jobOf(r, id)).toMatchObject({ state: 'scheduled', startAt: readyBy - HOUR });
    const posts = () =>
      r.fake.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/prepare'));
    r.clock.advance(3 * HOUR);
    await pass(r);
    expect(posts()).toHaveLength(0);

    // Later: rescheduled. Cleared: it starts at once.
    const later = r.clock() + 10 * HOUR;
    expect((await r.service.update(id, { readyBy: iso(later) })).readyBy).toBe(iso(later));
    await r.settle();
    expect(await jobOf(r, id)).toMatchObject({ state: 'scheduled', startAt: later - HOUR });
    const cleared = await r.service.update(id, { readyBy: null });
    expect(cleared.readyBy).toBeUndefined();
    await r.settle();
    expect(posts()).toHaveLength(1);
    await pass(r);
    expect((await view(r, id)).status).toBe('ready');
  });

  it('says once when the preparation will not finish in time', async () => {
    const r = await rig({ fake: { prepareSegmentsPerPoll: 1 } });
    const readyBy = r.clock() + 10 * MIN;
    const id = await full(r, 'movie', { readyBy: iso(readyBy) });
    await pass(r);
    expect(ofType(r.events, 'prepare.late')).toHaveLength(0);
    // Two segments of thirty in two minutes: about 28 more.
    r.clock.advance(LATE_MIN_ELAPSED_MS * 2);
    await pass(r);
    const late = ofType(r.events, 'prepare.late');
    expect(late).toHaveLength(1);
    expect(late[0]?.data).toEqual({
      sessionId: id,
      readyBy: iso(readyBy),
      expectedAt: iso(r.clock() + 28 * MIN),
    });
    r.clock.advance(20 * MIN);
    await pass(r);
    expect(ofType(r.events, 'prepare.late')).toHaveLength(1);

    // A new deadline is told about again, here because it is already past.
    await r.service.update(id, { readyBy: iso(r.clock() - MIN) });
    await pass(r);
    expect(ofType(r.events, 'prepare.late').at(-1)?.data.readyBy).toBe(iso(r.clock() - MIN));
    expect(ofType(r.events, 'prepare.late')).toHaveLength(2);
  });

  it('keeps the session until readyBy plus the idle time, and never sweeps one that is preparing', async () => {
    const r = await rig({ fake: { prepareSegmentsPerPoll: 10 } });
    const readyBy = r.clock() + 30 * MIN;
    const id = await full(r, 'movie', { readyBy: iso(readyBy) });
    r.clock.advance(3 * HOUR);
    expect(await r.service.sweep()).toMatchObject({ released: 0 });
    expect((await view(r, id)).status).toBe('preparing');

    const other = await full(r, 'other', { readyBy: iso(r.clock() + 4 * HOUR) });
    await pass(r);
    await pass(r);
    await pass(r);
    await pass(r);
    expect((await view(r, id)).status).toBe('ready');
    expect((await view(r, other)).status).toBe('preparing');
    r.clock.advance(HOUR + MIN);
    expect(await r.service.sweep()).toMatchObject({ released: 1 });
    expect((await view(r, id)).status).toBe('released');
    expect(await jobOf(r, id)).toBeUndefined();

    const now = r.clock();
    const kept = { retainUntil: null, lastAccess: now - 5 * HOUR, readyBy: now };
    expect(isDueForRelease(kept, HOUR, now + 59 * MIN)).toBe(false);
    expect(isDueForRelease(kept, HOUR, now + HOUR)).toBe(true);
    expect(isDueForRelease({ ...kept, status: 'failed' }, HOUR, now)).toBe(true);
    expect(isDueForRelease({ ...kept, status: 'preparing' }, HOUR, now + 9 * HOUR)).toBe(false);
  });
});

describe('when the engine does not finish', () => {
  it('starts a job that left gaps again once, and takes what it gets after that', async () => {
    const r = await rig();
    r.fake.prepareGaps = 2;
    const id = await full(r);
    await pass(r);
    const sid = (await view(r, id)).sid ?? '';
    expect(r.fake.sessions.get(sid)?.prepare?.starts).toBe(2);
    expect((await view(r, id)).status).toBe('preparing');
    await pass(r);
    expect(await jobOf(r, id)).toMatchObject({ state: 'done', doneSegments: 30, restarts: 1 });
    expect((await view(r, id)).status).toBe('ready');
  });

  it('fails the session when the engine job fails twice, and frees its engine session', async () => {
    const r = await rig();
    r.fake.prepareFailures = 2;
    const id = await full(r);
    const sid = (await view(r, id)).sid ?? '';
    await pass(r);
    expect((await view(r, id)).status).toBe('preparing');
    await pass(r);
    expect(await r.service.get(id)).toMatchObject({
      status: 'failed',
      failureReason: 'prepare-failed',
    });
    expect(ofType(r.events, 'session.failed').at(-1)?.data).toMatchObject({
      sessionId: id,
      reason: 'prepare-failed',
    });
    expect(r.fake.deletes).toEqual([sid]);
    expect(await jobOf(r, id)).toBeUndefined();
  });

  it("fails with prepare-too-large when the session can't fit the engine's cache cap", async () => {
    const r = await rig();
    r.fake.prepareTooLarge = true;
    const id = await full(r);
    expect((await view(r, id)).failureReason).toBe('prepare-too-large');
  });

  it('waits for an engine that does not answer, and queues a lost job again', async () => {
    const r = await rig({ fake: { prepareSegmentsPerPoll: 10 } });
    const id = await full(r);
    await pass(r);
    r.fake.online = false;
    await pass(r);
    await pass(r);
    expect(await jobOf(r, id)).toMatchObject({ state: 'running', doneSegments: 10 });
    r.fake.online = true;

    // An engine restart without persistence: the session and its job are gone.
    r.fake.restart();
    await pass(r);
    expect(ofType(r.events, 'prepare.lost').map((e) => e.data)).toEqual([
      { sessionId: id, reason: 'engine-session-lost' },
    ]);
    const sid = (await view(r, id)).sid ?? '';
    expect(r.fake.mastersFor(sid).map((m) => m.created)).toEqual([true, true]);
    expect((await view(r, id)).status).toBe('preparing');
    for (let i = 0; i < 4; i += 1) await pass(r);
    expect((await view(r, id)).status).toBe('ready');
  });
});

describe('a prepared session', () => {
  it('is checked before readyBy: one the engine lost is queued again', async () => {
    const r = await rig();
    const readyBy = r.clock() + 30 * MIN;
    const id = await full(r, 'movie', { readyBy: iso(readyBy) });
    await pass(r);
    expect((await view(r, id)).status).toBe('ready');
    r.fake.restart();
    await pass(r);
    expect(ofType(r.events, 'prepare.lost')).toHaveLength(0);

    r.clock.advance(30 * MIN - VERIFY_BEFORE_MS);
    await pass(r);
    expect(ofType(r.events, 'prepare.lost').map((e) => e.data.reason)).toEqual([
      'engine-session-lost',
    ]);
    expect(ofType(r.events, 'session.status').at(-1)?.data).toMatchObject({
      sessionId: id,
      status: 'preparing',
    });
    await pass(r);
    expect(await r.service.get(id)).toMatchObject({ status: 'ready' });
    expect(ofType(r.events, 'prepare.done')).toHaveLength(2);
    expect((await jobOf(r, id))?.verifiedAt).not.toBeNull();
  });

  it('is checked when a token is minted, at most once a minute', async () => {
    const r = await rig();
    const id = await full(r);
    await pass(r);
    const key = await r.keyFor('client');
    const mint = () =>
      r.app.request(`/v1/sessions/${id}/tokens`, {
        method: 'POST',
        headers: { ...bearer(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'tv' }),
      });
    const checks = () =>
      r.fake.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/prepare')).length;
    const before = checks();
    expect((await mint()).status).toBe(201);
    await r.settle();
    expect((await mint()).status).toBe(201);
    await r.settle();
    expect(checks()).toBe(before + 1);
    expect((await view(r, id)).status).toBe('ready');

    // The engine stopped the job (its segments are no longer pinned): started again quietly.
    const sid = (await view(r, id)).sid ?? '';
    const job = r.fake.sessions.get(sid)?.prepare;
    if (job === undefined) throw new Error('no job');
    job.state = 'idle';
    r.clock.advance(2 * MIN);
    await mint();
    await r.settle();
    expect(job).toMatchObject({ state: 'running', starts: 2 });
    expect((await view(r, id)).status).toBe('ready');

    r.fake.evict(sid);
    r.clock.advance(2 * MIN);
    await mint();
    await r.settle();
    expect(ofType(r.events, 'prepare.lost')).toHaveLength(1);
  });

  it('is released with its job, and a release while preparing ends the engine session', async () => {
    const r = await rig({ fake: { prepareSegmentsPerPoll: 1 } });
    const id = await full(r);
    const sid = (await view(r, id)).sid ?? '';
    await r.service.release(id, 'request');
    expect(r.fake.deletes).toEqual([sid]);
    expect(await jobOf(r, id)).toBeUndefined();
    await pass(r);
    expect((await view(r, id)).status).toBe('released');
  });
});

describe('a restart of Multitap', () => {
  it('goes on with stored preparations and fails a preparing session that has none', async () => {
    // 30 segments, 5 per read: the two passes here and the one at start leave it half done.
    const r = await rig({ fake: { prepareSegmentsPerPoll: 5 } });
    const id = await full(r);
    await pass(r);
    const orphan = await full(r, 'orphan');
    await r.repo.deletePrepareJob(orphan);
    r.service.stop();
    await r.settle();

    const second = new SessionService({
      repo: r.repo,
      engines: r.module,
      getEngine: (engineId) => getEngine(r.db, engineId),
      defaultEngine: () => defaultEngineId(r.db, r.config.selection.defaultEngine),
      streams: r.streams,
      autoSources: () => Promise.resolve([]),
      config: r.config,
      clock: r.clock,
      ids: sequentialIds(),
      logger: r.log.logger,
      events: r.bus,
    });
    try {
      await second.start();
      await second.idle();
      expect(await second.get(orphan)).toMatchObject({
        status: 'failed',
        failureReason: 'interrupted',
      });
      expect((await second.get(id))?.status).toBe('preparing');
      for (let i = 0; i < 3; i += 1) {
        await second.prepareJobs.tick();
        await second.idle();
      }
      expect(await second.get(id)).toMatchObject({
        status: 'ready',
        progress: { phase: 'prepared', preparedPct: 100 },
      });
    } finally {
      second.stop();
      await second.idle();
    }
  });
});
