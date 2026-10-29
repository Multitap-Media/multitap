/**
 * `GET /v1/events`: Multitap's event stream as server-sent events (see
 * okf:architecture/core-events-sse). Client scope; `settings.changed` and `engine.status` only reach
 * admin keys. Each message has `id:` (send it back as `Last-Event-ID`),
 * `event:` (the type) and `data:` (the whole event as JSON, `MultitapEvent`).
 * Comments (`: heartbeat`) keep idle connections open. A stream ends on
 * shutdown and once its key is revoked.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { EVENT_TYPES, type MultitapEvent, type EventType } from '@multitap/api';
import { streamSSE } from 'hono/streaming';
import { apiKeyActive } from '../../auth/keys.ts';
import type { EventFilter } from '../../events/bus.ts';
import { authResponses, BEARER_SECURITY } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import type { AppDeps, AppEnv } from '../types.ts';

/** Response header saying whether a `Last-Event-ID` replay had every missed event. */
export const REPLAY_HEADER = 'X-Events-Replay';

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
    'key is re-checked each time the stream wakes for an event or a heartbeat, before anything is sent.',
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
    const pending: MultitapEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = bus.subscribe(filter, (event) => {
      pending.push(event);
      wake?.();
    });
    if (lastEventId !== undefined) {
      const replay = bus.replay(lastEventId, filter);
      pending.unshift(...replay.events);
      c.header(REPLAY_HEADER, replay.complete ? 'complete' : 'partial');
    } else if (query.request !== undefined) {
      pending.unshift(...bus.replay('0', filter).events);
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
      const onShutdown = () => {
        wake?.();
      };
      shutdown?.addEventListener('abort', onShutdown);
      // Read through a function: `aborted` changes across awaits.
      const open = (): boolean => !stream.aborted && !stream.closed && shutdown?.aborted !== true;
      try {
        await stream.write(': connected\n\n');
        let lastSent = 0;
        while (open()) {
          let event: MultitapEvent | undefined;
          while (open() && (event = pending.shift()) !== undefined) {
            const id = Number(event.id);
            if (id <= lastSent) continue;
            lastSent = id;
            await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
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
          // heartbeat, also when the CLI revoked the key in another process.
          if (!(await apiKeyActive(deps.db, keyId))) {
            deps.logger.info({ apiKeyId: keyId }, 'event stream ended: api key revoked');
            break;
          }
          if (!woken && open()) await stream.write(': heartbeat\n\n');
        }
      } finally {
        shutdown?.removeEventListener('abort', onShutdown);
        unsubscribe();
        deps.metrics.setEventSubscribers(bus.subscriberCount);
      }
    });
  });
}
