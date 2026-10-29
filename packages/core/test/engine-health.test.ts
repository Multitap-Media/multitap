/** Engine health checks (phase 2 step 2): online/lastSeen, events, backoff. */
import type { MultitapEventInput } from '@multitap/api';
import { MultitapEventSchema } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.ts';
import {
  EngineHealthMonitor,
  healthDelay,
  RECHECK_MIN_GAP_MS,
  type Timers,
} from '../src/engines/health.ts';
import { getEngineView, putEngine } from '../src/engines/index.ts';
import { HOME_ENGINE } from './engine-fixture.ts';
import { EngineRegistry } from '../src/engines/registry.ts';
import { FakeEngine } from './fakes/engine.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

/** Timers driven by hand: `run()` fires every due callback in time order. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers & { advance(ms: number): void; delays: number[]; pending(): number } = {
    delays: [],
    setTimeout(fn, ms) {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      timers.delays.push(ms);
      return id;
    },
    clearTimeout(handle) {
      tasks.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...tasks]
          .filter(([, t]) => t.at <= now)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        due[1].fn();
      }
    },
    pending: () => tasks.size,
  };
  return timers;
}

const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.destroy()));
});

async function setup() {
  const db = await migratedMemoryDb();
  dbs.push(db);
  await putEngine(db, 'home', { ...HOME_ENGINE, address: 'http://engine.test:11470' });
  const fake = new FakeEngine();
  // `/ping` stands for any request the engine answers (a segment, a control
  // call); `metricsDown` fails only the health probe.
  const probe = { metricsDown: false, metricsRequests: 0 };
  const registry = new EngineRegistry({
    db,
    timeouts: { control: 1_000, prepare: 1_000, media: 1_000 },
    transportFactory: () => {
      const inner = fake.transport('home');
      return {
        kind: 'lan',
        async request(path, init) {
          if (path === '/metrics') probe.metricsRequests += 1;
          if (path === '/metrics' && probe.metricsDown && fake.online) {
            return new Response('', { status: 503 });
          }
          if (path === '/ping' && fake.online) return new Response('pong');
          return inner.request(path, init);
        },
      };
    },
  });
  const events: MultitapEventInput[] = [];
  const clock = manualClock();
  const timers = manualTimers();
  const log = memoryLogger();
  const monitor = new EngineHealthMonitor({
    db,
    registry,
    logger: log.logger,
    clock,
    bus: {
      publish(event) {
        events.push(event);
        return MultitapEventSchema.parse({
          id: '1',
          at: new Date(clock()).toISOString(),
          ...event,
        });
      },
    },
    intervalMs: 30_000,
    timeoutMs: 1_000,
    maxBackoffMs: 300_000,
    timers,
  });
  /** A request answered by the engine, outside the health checks. */
  const ping = async () => {
    const entry = await registry.get('home');
    await entry?.client.transport.request('/ping', { timeoutMs: 1_000 }).catch(() => undefined);
  };
  return { db, fake, probe, ping, registry, events, clock, timers, monitor, log };
}

describe('engine health', () => {
  it('marks an answering engine online, stores last_seen, and publishes once per change', async () => {
    const { db, fake, registry, events, clock, monitor } = await setup();
    expect(await monitor.check('home')).toBe(true);
    expect(registry.isOnline('home')).toBe(true);
    const seen = new Date(clock()).toISOString();
    expect(await getEngineView(db, 'home', registry)).toMatchObject({
      online: true,
      lastSeen: seen,
    });

    clock.advance(1_000);
    await monitor.check('home');
    expect(events).toHaveLength(1);

    fake.online = false;
    clock.advance(1_000);
    expect(await monitor.check('home')).toBe(false);
    expect(events).toEqual([
      { type: 'engine.status', data: { engineId: 'home', online: true, lastSeen: seen } },
      {
        type: 'engine.status',
        data: {
          engineId: 'home',
          online: false,
          lastSeen: new Date(clock() - 1_000).toISOString(),
        },
      },
    ]);
    const view = await getEngineView(db, 'home', registry);
    expect(view?.online).toBe(false);
    expect(view?.lastSeen).toBe(new Date(clock() - 1_000).toISOString());
  });

  it('an engine that never answered is offline with lastSeen null', async () => {
    const { db, fake, registry, events, monitor } = await setup();
    fake.online = false;
    await monitor.check('home');
    expect(events).toEqual([
      { type: 'engine.status', data: { engineId: 'home', online: false, lastSeen: null } },
    ]);
    expect(await getEngineView(db, 'home', registry)).toMatchObject({
      online: false,
      lastSeen: null,
    });
    expect(await getEngineView(db, 'home')).toMatchObject({ online: false, lastSeen: null });
  });

  it('coming back online resets cached capabilities', async () => {
    const { fake, registry, monitor } = await setup();
    const entry = await registry.get('home');
    await entry?.client.supportsDelete();
    fake.online = false;
    await monitor.check('home');
    fake.online = true;
    await monitor.check('home');
    await entry?.client.supportsDelete();
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(2);
  });

  it('backs off exponentially up to the maximum', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => healthDelay(n, 30_000, 300_000))).toEqual([
      30_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it('schedules checks: interval while online, backoff while offline, and follows engine edits', async () => {
    const { db, fake, timers, monitor, registry } = await setup();
    monitor.start();
    await monitor.idle(); // sync
    timers.advance(0); // first check
    await monitor.idle();
    expect(registry.isOnline('home')).toBe(true);
    fake.online = false;
    timers.advance(30_000);
    await monitor.idle();
    timers.advance(30_000);
    await monitor.idle();
    expect(registry.isOnline('home')).toBe(false);
    // After two failures the next check waits 60 s.
    expect(timers.delays.at(-1)).toBe(60_000);

    await putEngine(db, 'second', { ...HOME_ENGINE, address: 'http://other.test:11470' });
    timers.advance(60_000);
    await monitor.idle();
    timers.advance(0);
    await monitor.idle();
    expect(registry.health('second')).toBeDefined();

    monitor.stop();
    expect(timers.pending()).toBe(0);
  });

  it('an address set on an engine backed off for having none is checked at the next sync', async () => {
    const { db, timers, monitor, registry } = await setup();
    await putEngine(db, 'home', { ...HOME_ENGINE, address: null });
    monitor.start();
    await monitor.idle();
    // Backed off: 30 s, 60 s, 120 s, 240 s, then 300 s between checks.
    for (const ms of [0, 30_000, 60_000, 120_000, 240_000]) {
      timers.advance(ms);
      await monitor.idle();
    }
    expect(registry.isOnline('home')).toBe(false);
    expect(timers.delays.at(-1)).toBe(300_000);

    await putEngine(db, 'home', { ...HOME_ENGINE, address: 'http://engine.test:11470' });
    // The engine list is re-read every interval; the new address is checked then, not 300 s later.
    timers.advance(30_000);
    await monitor.idle();
    timers.advance(0);
    await monitor.idle();
    expect(registry.isOnline('home')).toBe(true);
    monitor.stop();
  });

  it('an engine without an address is offline without a request', async () => {
    const { db, fake, monitor } = await setup();
    await putEngine(db, 'home', { ...HOME_ENGINE, address: null });
    expect(await monitor.check('home')).toBe(false);
    expect(fake.requests).toEqual([]);
  });

  it('a new address makes the health unknown again, keeping lastSeen', async () => {
    const { db, fake, registry, clock, monitor } = await setup();
    await monitor.check('home');
    const seen = registry.health('home')?.lastSeen;
    fake.online = false;
    await monitor.check('home');
    expect(registry.isOnline('home')).toBe(false);

    await putEngine(db, 'home', { ...HOME_ENGINE, address: 'http://moved.test:11470' });
    await registry.get('home');
    expect(registry.isOnline('home')).toBeUndefined();
    expect(registry.health('home')?.lastSeen).toBe(seen);

    // The same address again keeps the result.
    fake.online = false;
    clock.advance(1_000);
    await monitor.check('home');
    await registry.get('home');
    expect(registry.isOnline('home')).toBe(false);
  });
  it('re-checks an offline engine at once when it answers a request, without waiting for the backoff', async () => {
    const { fake, ping, events, timers, monitor, registry } = await setup();
    monitor.start();
    await monitor.idle();
    timers.advance(0);
    await monitor.idle();
    fake.online = false;
    for (const ms of [30_000, 30_000, 60_000]) {
      timers.advance(ms);
      await monitor.idle();
    }
    expect(registry.isOnline('home')).toBe(false);
    expect(timers.delays.at(-1)).toBe(120_000);

    // A failed request changes nothing.
    await ping();
    timers.advance(0);
    await monitor.idle();
    expect(events.at(-1)).toMatchObject({ data: { online: false } });

    fake.online = true;
    await ping();
    // The answer alone doesn't set online: the health check does.
    expect(registry.isOnline('home')).toBe(false);
    timers.advance(0);
    await monitor.idle();
    expect(registry.isOnline('home')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'engine.status', data: { online: true } });
    // Back on the normal interval.
    expect(timers.delays.at(-1)).toBe(30_000);
    monitor.stop();
    expect(timers.pending()).toBe(0);
  });

  it('answer-triggered re-checks are coalesced, at most one per gap, and reset the backoff', async () => {
    const { fake, probe, ping, timers, monitor, registry } = await setup();
    monitor.start();
    await monitor.idle();
    timers.advance(0);
    await monitor.idle();

    // Answers while online trigger nothing.
    await ping();
    await ping();
    timers.advance(0);
    await monitor.idle();
    expect(probe.metricsRequests).toBe(1);

    // The probe fails while other requests succeed (e.g. a half-started engine).
    probe.metricsDown = true;
    for (const ms of [30_000, 30_000, 60_000]) {
      timers.advance(ms);
      await monitor.idle();
    }
    expect(registry.isOnline('home')).toBe(false);
    expect(timers.delays.at(-1)).toBe(120_000);
    const before = probe.metricsRequests;

    await ping();
    await ping();
    await ping();
    timers.advance(0);
    await monitor.idle();
    // One re-check for three answers; it failed, but the backoff starts over.
    expect(probe.metricsRequests).toBe(before + 1);
    expect(registry.isOnline('home')).toBe(false);
    expect(timers.delays.at(-1)).toBe(30_000);

    // Within the gap: coalesced into one re-check at its end.
    await ping();
    await ping();
    timers.advance(RECHECK_MIN_GAP_MS - 1);
    await monitor.idle();
    expect(probe.metricsRequests).toBe(before + 1);
    timers.advance(1);
    await monitor.idle();
    expect(probe.metricsRequests).toBe(before + 2);

    probe.metricsDown = false;
    await ping();
    timers.advance(RECHECK_MIN_GAP_MS);
    await monitor.idle();
    expect(probe.metricsRequests).toBe(before + 3);
    expect(registry.isOnline('home')).toBe(true);
    expect(fake.online).toBe(true);
    monitor.stop();
    expect(timers.pending()).toBe(0);
  });
});
