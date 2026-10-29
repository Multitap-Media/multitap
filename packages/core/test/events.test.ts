/**
 * Events (phase 2 step 6): the in-memory bus (ids, replay buffer, filters),
 * `GET /v1/events` over SSE (replay with `Last-Event-ID`, heartbeats, session
 * and admin filtering, ending on key revocation) and `streams.partial` from
 * incremental source lists.
 * Every event is validated against `MultitapEventSchema`.
 */
import {
  MultitapEventSchema,
  SourceListStartedSchema,
  type MultitapEvent,
  type MultitapEventInput,
} from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKey, revokeApiKey } from '../src/auth/keys.ts';
import { MemoryEventBus } from '../src/events/memory-bus.ts';
import { REPLAY_HEADER } from '../src/http/routes/events.ts';
import { autoSourcesFor } from '../src/http/selection-deps.ts';
import { HOME_ENGINE } from './engine-fixture.ts';
import { startFakeAddon, type FakeAddon } from './fakes/addon.ts';
import { bearer, manualClock } from './helpers.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const status = (sessionId: string): MultitapEventInput => ({
  type: 'session.status',
  data: { sessionId, status: 'resolving' },
});
const settings: MultitapEventInput = { type: 'settings.changed', data: { key: 'ranking' } };

describe('MemoryEventBus', () => {
  const make = (replaySize = 3) => {
    const clock = manualClock();
    const counts: number[] = [];
    const bus = new MemoryEventBus({
      clock,
      replaySize,
      validate: true,
      onSubscribers: (n) => counts.push(n),
    });
    return { bus, clock, counts };
  };

  it('assigns increasing ids and the clock time, and validates events', () => {
    const { bus, clock } = make();
    expect(bus.lastEventId).toBeUndefined();
    const a = bus.publish(status('ps_a'));
    clock.advance(1_000);
    const b = bus.publish(status('ps_b'));
    expect([a.id, b.id]).toEqual(['1', '2']);
    expect(Date.parse(b.at) - Date.parse(a.at)).toBe(1_000);
    expect(bus.lastEventId).toBe('2');
    expect(MultitapEventSchema.parse(a)).toEqual(a);
    // An invalid event is rejected and uses no id.
    expect(() =>
      bus.publish({ type: 'session.failed', data: { sessionId: 'ps_a' } } as MultitapEventInput),
    ).toThrow();
    expect(bus.publish(status('ps_c')).id).toBe('3');
  });

  it('delivers by filter; admin types only to admin subscribers; listeners are isolated', () => {
    const { bus, counts } = make();
    const all: string[] = [];
    const admin: string[] = [];
    const one: string[] = [];
    const statusOnly: string[] = [];
    bus.subscribe({}, (e) => all.push(e.type));
    bus.subscribe({ admin: true }, (e) => admin.push(e.type));
    bus.subscribe({ sessionId: 'ps_a' }, (e) => one.push(e.id));
    bus.subscribe({}, () => {
      throw new Error('boom');
    });
    const unsubscribe = bus.subscribe({ types: ['session.status'] }, (e) => statusOnly.push(e.id));
    expect(bus.subscriberCount).toBe(5);
    bus.publish(status('ps_a'));
    bus.publish(status('ps_b'));
    bus.publish(settings);
    unsubscribe();
    unsubscribe();
    bus.publish(status('ps_a'));
    expect(all).toEqual(['session.status', 'session.status', 'session.status']);
    expect(admin).toEqual([
      'session.status',
      'session.status',
      'settings.changed',
      'session.status',
    ]);
    expect(one).toEqual(['1', '4']);
    expect(statusOnly).toEqual(['1', '2']);
    expect(counts).toEqual([1, 2, 3, 4, 5, 4]);
  });

  it('replays from a bounded buffer and says when events were lost', () => {
    const { bus } = make(3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) bus.publish(status(`ps_${id}`)); // ids 1–5; buffer 3–5
    const ids = (r: { events: MultitapEvent[] }) => r.events.map((e) => e.id);
    expect(bus.replay('5', {})).toEqual({ events: [], complete: true });
    expect(ids(bus.replay('3', {}))).toEqual(['4', '5']);
    expect(bus.replay('3', {}).complete).toBe(true);
    expect(bus.replay('2', {})).toMatchObject({ complete: true }); // 3 is the next one, still held
    expect(bus.replay('1', {})).toMatchObject({ complete: false });
    expect(ids(bus.replay('1', {}))).toEqual(['3', '4', '5']);
    // From before a restart, or garbage.
    expect(bus.replay('99', {})).toMatchObject({ complete: false });
    expect(bus.replay('abc', {})).toMatchObject({ complete: false });
    // Filtered.
    expect(ids(bus.replay('2', { sessionId: 'ps_d' }))).toEqual(['4']);
  });

  it('keeps nothing with a zero-size buffer', () => {
    const { bus } = make(0);
    bus.publish(status('ps_a'));
    expect(bus.replay('0', {})).toEqual({ events: [], complete: false });
  });
});

// ---- SSE ---------------------------------------------------------------------------------

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Opens `/v1/events` and parses messages as they arrive. */
async function openEvents(rig: Rig, key: string, query = '', headers: Record<string, string> = {}) {
  const res = await rig.app.request(`/v1/events${query}`, {
    headers: { ...bearer(key), ...headers },
  });
  const messages: SseMessage[] = [];
  if (res.status !== 200 || res.body === null) {
    return {
      res,
      messages,
      events: () => [],
      until: () => Promise.resolve(),
      ended: () => Promise.resolve(),
      close: () => undefined,
    };
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = () =>
    messages.flatMap((m) => {
      if (m.data === undefined) return [];
      const event = MultitapEventSchema.parse(JSON.parse(m.data));
      expect(event.id).toBe(m.id);
      expect(event.type).toBe(m.event);
      return [event];
    });
  /** Reads the next chunk into `messages`; false once the stream has ended. */
  const pull = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const message: SseMessage = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) message.comment = line.slice(1).trim();
        else if (line.startsWith('id: ')) message.id = line.slice(4);
        else if (line.startsWith('event: ')) message.event = line.slice(7);
        else if (line.startsWith('data: ')) message.data = line.slice(6);
      }
      messages.push(message);
    }
    return true;
  };
  const until = async (done: () => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for events');
      if (!(await pull())) throw new Error('event stream ended');
    }
  };
  /** Reads until Multitap ends the stream. */
  const ended = async (timeoutMs = 3_000) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('event stream still open'));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          while (await pull());
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    res,
    messages,
    events,
    until,
    ended,
    close: () => {
      void reader.cancel();
    },
  };
}

const rigs: Rig[] = [];
const addons: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(addons.splice(0).map((a) => a.close()));
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});

async function rig(options?: Parameters<typeof sessionRig>[0]) {
  const r = await sessionRig(options);
  rigs.push(r);
  return r;
}

describe('GET /v1/events', () => {
  it('streams a session’s lifecycle, filtered by session', async () => {
    const r = await rig();
    const key = await r.keyFor('client');
    const candidate = r.list(httpStream('good'));
    const other = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();

    const created = await r.app.request('/v1/sessions', {
      method: 'POST',
      headers: { ...bearer(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: MOVIE, source: { key: candidate } }),
    });
    const session = (await created.json()) as { id: string };
    const stream = await openEvents(r, key, `?session=${session.id}`);
    expect(stream.res.headers.get('Content-Type')).toContain('text/event-stream');
    // Subscribed after the create: what was missed comes from the replay below.
    await r.settle();
    r.service.stop();
    await r.service.release(session.id, 'request');
    await stream.until(() => stream.events().some((e) => e.type === 'session.released'));
    const seen = stream.events();
    expect(seen.every((e) => 'sessionId' in e.data && e.data.sessionId === session.id)).toBe(true);
    expect(seen.map((e) => e.data)).not.toContainEqual(
      expect.objectContaining({ sessionId: other.session.id }),
    );
    stream.close();

    // Resume from the first event: everything after it, in order, complete.
    const first = r.events.find((e) => 'sessionId' in e.data && e.data.sessionId === session.id);
    const resumed = await openEvents(r, key, `?session=${session.id}`, {
      'Last-Event-ID': first?.id ?? '',
    });
    expect(resumed.res.headers.get(REPLAY_HEADER)).toBe('complete');
    await resumed.until(() => resumed.events().some((e) => e.type === 'session.released'));
    const replayed = resumed.events();
    expect(replayed.map((e) => e.type)).toEqual(
      r.events
        .filter((e) => 'sessionId' in e.data && e.data.sessionId === session.id)
        .slice(1)
        .map((e) => e.type),
    );
    expect(replayed.map((e) => e.type)).toContain('session.ready');
    resumed.close();
  });

  it('marks a replay from an unknown id as partial', async () => {
    const r = await rig();
    const key = await r.keyFor('client');
    await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    const stream = await openEvents(r, key, '', { 'Last-Event-ID': '999' });
    expect(stream.res.headers.get(REPLAY_HEADER)).toBe('partial');
    await stream.until(() => stream.events().length >= 2);
    expect(stream.events()[0]?.id).toBe('1');
    stream.close();
  });

  it('sends admin-only events to admin keys only, and heartbeats', async () => {
    const r = await rig();
    r.config.events.heartbeatMs = 20;
    const client = await openEvents(r, await r.keyFor('client'));
    const admin = await openEvents(r, await r.keyFor('admin'), '?types=settings.changed');
    r.bus.publish(settings);
    r.bus.publish(status('ps_x'));
    await admin.until(() => admin.events().length === 1);
    expect(admin.events()[0]?.type).toBe('settings.changed');
    await client.until(() => client.events().length === 1);
    expect(client.events()[0]?.type).toBe('session.status');
    await client.until(() => client.messages.some((m) => m.comment === 'heartbeat'));
    client.close();
    admin.close();
  });

  it('rejects unknown types', async () => {
    const r = await rig();
    const res = await r.app.request('/v1/events?types=session.ready,nope', {
      headers: bearer(await r.keyFor('client')),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('nope');
  });

  it('needs a key', async () => {
    const r = await rig();
    expect((await r.app.request('/v1/events')).status).toBe(404);
  });

  // Adversarial review finding sec-access-sse-outlives-key-revocation.
  it('ends an open stream when its key is revoked, delivering nothing after', async () => {
    const r = await rig();
    const leaked = await createApiKey(r.db, { scope: 'admin', label: 'leaked' }, r.clock);
    const stream = await openEvents(r, leaked.key, '?types=settings.changed');
    await stream.until(() => stream.messages.some((m) => m.comment === 'connected'));

    const res = await r.app.request(`/v1/admin/api-keys/${leaked.id}`, {
      method: 'DELETE',
      headers: bearer(await r.keyFor('admin')),
    });
    expect(res.status).toBe(200);
    // An admin-only event published after the revocation.
    r.bus.publish(settings);
    await stream.ended();
    expect(stream.events()).toEqual([]);
    expect(r.log.lines()).toContainEqual(
      expect.objectContaining({ apiKeyId: leaked.id, msg: 'event stream ended: api key revoked' }),
    );
  });

  it('ends an idle stream at the next heartbeat when the key is revoked from the CLI', async () => {
    const r = await rig();
    r.config.events.heartbeatMs = 20;
    const leaked = await createApiKey(r.db, { scope: 'client', label: 'leaked' }, r.clock);
    const stream = await openEvents(r, leaked.key);
    await stream.until(() => stream.messages.some((m) => m.comment === 'heartbeat'));
    // What `multitap api-key revoke` does, from another process: only the database changes.
    await revokeApiKey(r.db, leaked.id, r.clock);
    await stream.ended();
    expect(stream.events()).toEqual([]);
  });
});

// ---- streams.partial ----------------------------------------------------------------------------

describe('incremental source lists (streams.partial)', () => {
  it('answers 202 with a request id, then one event per addon, the last with remaining 0', async () => {
    const r = await rig();
    for (const fixture of ['torrentio-public', 'easynews'] as const) {
      const fake = await startFakeAddon({
        fixture,
        latencyMs: fixture === 'easynews' ? 50 : 0,
      });
      addons.push(fake);
      await r.addons.collection.add(fake.manifestUrl);
    }
    const key = await r.keyFor('client');
    const res = await r.app.request('/v1/streams/movie/tt1375666?incremental=true&sort=rank', {
      headers: bearer(key),
    });
    expect(res.status).toBe(202);
    const started = SourceListStartedSchema.parse(await res.json());
    expect(started).toMatchObject({ engine: 'home', highRes: 'off', addons: 2 });
    expect(started.requestId).toMatch(/^rq_/);

    const stream = await openEvents(r, key, `?request=${started.requestId}`);
    await stream.until(() =>
      stream.events().some((e) => e.type === 'streams.partial' && e.data.remaining === 0),
    );
    const partials = stream
      .events()
      .filter(
        (e): e is Extract<MultitapEvent, { type: 'streams.partial' }> =>
          e.type === 'streams.partial',
      );
    expect(partials.map((p) => [p.data.addon.addonName, p.data.remaining])).toEqual([
      ['Torrentio', 1],
      [expect.any(String), 0],
    ]);
    expect(partials[0]?.data.candidates).toHaveLength(20);
    const scores = partials[0]?.data.candidates.filter((c) => c.playable).map((c) => c.score) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // The keys are live: a session can be created from one.
    const pick = partials[1]?.data.candidates.find((c) => c.playable);
    expect(r.streams.get(pick?.key ?? '')).toBeDefined();
    stream.close();
  });

  it('auto-select ranks the same source list', async () => {
    const r = await rig();
    const fake = await startFakeAddon({ fixture: 'easynews' });
    addons.push(fake);
    await r.addons.collection.add(fake.manifestUrl);
    const list = await autoSourcesFor(r.appDeps)({
      item: { type: 'movie', id: 'tt1375666' },
      engine: { ...HOME_ENGINE },
      highRes: 'off',
      preferredLanguages: ['eng'],
    });
    expect(list).toHaveLength(6);
    expect(list.every((c) => r.streams.get(c.key) !== undefined)).toBe(true);
  });
});
