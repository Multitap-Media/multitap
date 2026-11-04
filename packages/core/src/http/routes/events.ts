/**
 * `GET /v1/events`: Multitap's event stream as server-sent events (see
 * okf:architecture/core-events-sse). Client scope; `settings.changed` and `engine.status` only reach
 * admin keys. Each message has `id:` (send it back as `Last-Event-ID`),
 * `event:` (the type) and `data:` (the whole event as JSON, `MultitapEvent`).
 * Comments (`: heartbeat`) keep idle connections open. A stream ends on
 * shutdown, once its key is revoked, and when its reader falls
 * {@link EVENTS_PENDING_LIMIT} events behind.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { EVENT_TYPES, type MultitapEvent, type EventType } from '@multitap/api';
import { streamSSE } from 'hono/streaming';
import { apiKeyActiveCached } from '../../auth/keys.ts';
import type { EventFilter } from '../../events/bus.ts';
import { authResponses, BEARER_SECURITY } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import type { AppDeps, AppEnv } from '../types.ts';

/** Response header saying whether a `Last-Event-ID` replay had every missed event. */
export const REPLAY_HEADER = 'X-Events-Replay';

/**
 * Live events a stream may have waiting, on top of its replay, before it is
 * ended: a reader that slow reconnects with `Last-Event-ID` and gets what the
 * replay buffer still holds (`partial` when that's not everything).
 */
export const EVENTS_PENDING_LIMIT = 10_000;

/** Each event's `data:`, serialised once however many streams send it. */
const serialized = new WeakMap<MultitapEvent, string>();

function dataOf(event: MultitapEvent): string {
  let data = serialized.get(event);
  if (data === undefined) {
    data = JSON.stringify(event);
    serialized.set(event, data);
  }
  return data;
}

/**
 * Per shutdown signal, the open streams to wake when it aborts: one listener
 * on the signal however many streams are open (no `MaxListenersExceeded`).
 */
const shutdownWakers = new WeakMap<AbortSignal, Set<() => void>>();

/** Calls `wake` when `signal` aborts; returns the function that stops that. */
function onAbort(signal: AbortSignal, wake: () => void): () => void {
  let wakers = shutdownWakers.get(signal);
  if (wakers === undefined) {
    const created = new Set<() => void>();
    wakers = created;
    shutdownWakers.set(signal, created);
    signal.addEventListener(
      'abort',
      () => {
        for (const w of [...created]) w();
      },
      { once: true },
    );
  }
  const set = wakers;
  set.add(wake);
  return () => {
    set.delete(wake);
  };
}

/** A FIFO with O(1) takes from the front (an array's `shift` is O(n)). */
class EventQueue {
  #items: (MultitapEvent | undefined)[] = [];
  #head = 0;

  get length(): number {
    return this.#items.length - this.#head;
  }

  push(event: MultitapEvent): void {
    this.#items.push(event);
  }

  /** Puts `events` before everything queued (no spread: a replay can be 100 000 events). */
  prepend(events: readonly MultitapEvent[]): void {
    this.#items = (events as readonly (MultitapEvent | undefined)[]).concat(
      this.#items.slice(this.#head),
    );
    this.#head = 0;
  }

  shift(): MultitapEvent | undefined {
    if (this.#head >= this.#items.length) return undefined;
    const event = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head += 1;
    if (this.#head >= 1_024 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return event;
  }
}

const eventsRoute = createRoute({
  method: 'get',
  path: '/v1/events',
  operationId: 'streamEvents',
  summary: 'Follow Multitap events (server-sent events)',
  description:
    'Messages carry `id`, `event` (the type) and `data` (the event as JSON; the `MultitapEvent` schema). ' +
    'On reconnect, `Last-Event-ID` replays missed events from a bounded buffer; the `X-Events-Replay` ' +
    'header says `complete`, or `partial` when some were lost (re-read session state then). ' +
    'With `request` and no `Last-Event-ID`, every buffered event of that source list is replayed first. ' +
    '`settings.changed` and `engine.status` reach admin keys only. A `: heartbeat` comment is sent every ' +
    '`MULTITAP_EVENTS_HEARTBEAT_MS`. The stream ends when Multitap shuts down, and when its API key is revoked: the ' +
    'key is re-checked each time the stream wakes for an event or a heartbeat, before anything is sent (a revocation ' +
    'from the API is seen at once, one from the CLI within about a second). It also ends when a slow reader has ' +
    `more than ${String(EVENTS_PENDING_LIMIT)} events waiting beyond its replay: reconnect with \`Last-Event-ID\`.`,
  tags: ['events'],
  security: BEARER_SECURITY,
  request: {
    query: z.object({
      session: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .openapi({
          param: { name: 'session', in: 'query' },
          description: 'Only events about this playback session.',
          example: 'ps_3q2x7wAbCdEfGhIjKlMnOp',
        }),
      request: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .openapi({
          param: { name: 'request', in: 'query' },
          description: 'Only `streams.partial` events of this incremental source list.',
          example: 'rq_3q2x7wAbCdEfGhIjKlMnOp',
        }),
      types: z
        .string()
        .regex(/^[a-z.]+(,[a-z.]+)*$/)
        .optional()
        .openapi({
          param: { name: 'types', in: 'query' },
          description: 'Comma-separated event types to receive (default: all).',
          example: 'session.ready,session.failed',
        }),
    }),
    headers: z.object({
      'last-event-id': z
        .string()
        .max(64)
        .optional()
        .openapi({
          param: { name: 'last-event-id', in: 'header' },
          description: 'The last event id received, to resume.',
          example: '1042',
        }),
    }),
  },
  responses: {
    200: {
      description: 'An event stream that stays open',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    400: problemContent('The request failed validation, or names an unknown event type'),
    ...authResponses,
    503: problemContent('Multitap runs without an event bus'),
  },
});

const KNOWN_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/** `/v1/events`. The caller mounts the client-scope middleware. */
export function registerEventRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(eventsRoute, (c) => {
    const bus = deps.events;
    if (bus === undefined) throw new ProblemError(503, 'Events are not available.');
    const query = c.req.valid('query');
    const lastEventId = c.req.valid('header')['last-event-id'];

    const { id: keyId, scope } = c.get('apiKey');
    const filter: EventFilter = { admin: scope === 'admin' };
    if (query.session !== undefined) filter.sessionId = query.session;
    if (query.request !== undefined) filter.requestId = query.request;
    if (query.types !== undefined) {
      const types = query.types.split(',');
      const unknown = types.filter((type) => !KNOWN_TYPES.has(type));
      if (unknown.length > 0) {
        throw new ProblemError(400, `Unknown event types: ${unknown.join(', ')}.`);
      }
      filter.types = types as EventType[];
    }

    // Subscribe before replaying, so nothing published in between is lost;
    // duplicates are dropped by id below.
    const pending = new EventQueue();
    const limit = deps.config.events.replaySize + EVENTS_PENDING_LIMIT;
    let wake: (() => void) | undefined;
    /** The reader fell too far behind: the stream ends. */
    let overflowed = false;
    const unsubscribe = bus.subscribe(filter, (event) => {
      if (overflowed) return;
      if (pending.length >= limit) {
        overflowed = true;
        unsubscribe();
      } else {
        pending.push(event);
      }
      wake?.();
    });
    if (lastEventId !== undefined) {
      const replay = bus.replay(lastEventId, filter);
      pending.prepend(replay.events);
      c.header(REPLAY_HEADER, replay.complete ? 'complete' : 'partial');
    } else if (query.request !== undefined) {
      pending.prepend(bus.replay('0', filter).events);
    }

    const heartbeatMs = deps.config.events.heartbeatMs;
    deps.metrics.setEventSubscribers(bus.subscriberCount);
    const shutdown = deps.shutdown;
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      // Multitap shutting down ends the stream; the client reconnects with
      // Last-Event-ID once Multitap is back.
      const stopWaking =
        shutdown === undefined
          ? () => undefined
          : onAbort(shutdown, () => {
              wake?.();
            });
      // Read through a function: `aborted` changes across awaits.
      const open = (): boolean =>
        !stream.aborted && !stream.closed && shutdown?.aborted !== true && !overflowed;
      try {
        await stream.write(': connected\n\n');
        let lastSent = 0;
        while (open()) {
          let event: MultitapEvent | undefined;
          while (open() && (event = pending.shift()) !== undefined) {
            const id = Number(event.id);
            if (id <= lastSent) continue;
            lastSent = id;
            await stream.writeSSE({ id: event.id, event: event.type, data: dataOf(event) });
          }
          if (!open()) break;
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              resolve(false);
            }, heartbeatMs);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          wake = undefined;
          if (!open()) break;
          // A revoked key gets nothing more. Checked on every wake-up, before
          // anything is written, so the stream ends at the next event or
          // heartbeat. The answer is shared by the key's streams for up to a
          // second (one query, not one per stream and event); a revocation in
          // this process is seen at once, one by the CLI in another within it.
          if (!(await apiKeyActiveCached(deps.db, keyId, deps.clock))) {
            deps.logger.info({ apiKeyId: keyId }, 'event stream ended: api key revoked');
            break;
          }
          if (!woken && open()) await stream.write(': heartbeat\n\n');
        }
        if (overflowed) {
          deps.logger.info(
            { apiKeyId: keyId, lastEventId: lastSent === 0 ? undefined : String(lastSent) },
            'event stream ended: the reader fell too far behind',
          );
        }
      } finally {
        stopWaking();
        unsubscribe();
        deps.metrics.setEventSubscribers(bus.subscriberCount);
      }
    });
  });
}
