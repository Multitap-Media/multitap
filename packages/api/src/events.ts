/**
 * `/v1/events` payloads (okf:architecture/core-v1-api, okf:architecture/core-api-testing). OpenAPI describes SSE
 * poorly, so these zod schemas are the contract: every event Multitap emits in
 * tests is validated against {@link MultitapEventSchema}.
 *
 * On the wire each event is one SSE message: `id:` is {@link MultitapEvent.id},
 * `event:` is its `type`, and `data:` is the whole event as JSON. Event ids
 * increase; `Last-Event-ID` replays from a bounded buffer, and a client that
 * missed more re-reads session state. The type list is declared in full,
 * including `prepare.*`, which phase 4 produces.
 */
import { z } from 'zod';
import { AddonStatusSchema } from './browse.ts';
import {
  EngineStatusSchema,
  PLAYBACK_SESSION_STATUSES,
  PlaybackSessionSchema,
  RELEASE_REASONS,
} from './sessions.ts';
import { SourceCandidateSchema } from './selection.ts';

export const EVENT_TYPES = [
  'session.status',
  'session.ready',
  'session.failed',
  'session.released',
  'streams.partial',
  'prepare.progress',
  'prepare.done',
  'prepare.lost',
  'prepare.late',
  'settings.changed',
  'engine.status',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Events only admin keys receive. */
export const ADMIN_EVENT_TYPES: readonly EventType[] = ['settings.changed', 'engine.status'];

const timestamp = z.iso.datetime().meta({ example: '2026-09-30T20:00:00.000Z' });
const sessionId = z.string().meta({ example: 'ps_3q2x7wAbCdEfGhIjKlMnOp' });

const envelope = {
  id: z.string().meta({
    description: 'Increasing event id; send it back as `Last-Event-ID` to resume.',
    example: '1042',
  }),
  at: timestamp,
};

function event<T extends EventType, D extends z.ZodType>(type: T, data: D) {
  return z.object({ ...envelope, type: z.literal(type), data });
}

// ---- Sessions ----------------------------------------------------------------------

export const SessionStatusEventSchema = event(
  'session.status',
  z.object({
    sessionId,
    status: z.enum(PLAYBACK_SESSION_STATUSES),
    progress: EngineStatusSchema.optional(),
    chosen: z.string().optional().meta({ description: 'The candidate being tried or playing.' }),
  }),
).meta({ id: 'SessionStatusEvent' });

export const SessionReadyEventSchema = event(
  'session.ready',
  z.object({ sessionId, session: PlaybackSessionSchema }),
).meta({ id: 'SessionReadyEvent' });

export const SessionFailedEventSchema = event(
  'session.failed',
  z.object({
    sessionId,
    reason: z.string().meta({ description: 'As `PlaybackSession.failureReason`.' }),
    attempts: z.number().int().nonnegative().optional().meta({
      description: 'Auto-select: candidates tried.',
    }),
  }),
).meta({ id: 'SessionFailedEvent' });

export const SessionReleasedEventSchema = event(
  'session.released',
  z.object({ sessionId, reason: z.enum(RELEASE_REASONS) }),
).meta({ id: 'SessionReleasedEvent' });

// ---- Incremental source lists (okf:concept/addon-aggregation) --------------------------------------------------

export const StreamsPartialEventSchema = event(
  'streams.partial',
  z.object({
    requestId: z.string().meta({ description: 'From the `/v1/streams` response that started it.' }),
    addon: AddonStatusSchema,
    candidates: z.array(SourceCandidateSchema).meta({
      description: "This addon's candidates, annotated like the full list.",
    }),
    remaining: z.number().int().nonnegative().meta({
      description: 'Addons still to answer; 0 on the last event for the request.',
    }),
  }),
).meta({ id: 'StreamsPartialEvent' });

// ---- Preparation (okf:architecture/engine-prepare-ahead, phase 4) ------------------------------------------------------

export const PrepareProgressEventSchema = event(
  'prepare.progress',
  z.object({ sessionId, preparedPct: z.number().min(0).max(100) }),
).meta({ id: 'PrepareProgressEvent' });

export const PrepareDoneEventSchema = event('prepare.done', z.object({ sessionId })).meta({
  id: 'PrepareDoneEvent',
});

export const PrepareLostEventSchema = event(
  'prepare.lost',
  z.object({ sessionId, reason: z.string().optional() }),
).meta({ id: 'PrepareLostEvent' });

export const PrepareLateEventSchema = event(
  'prepare.late',
  z.object({
    sessionId,
    readyBy: timestamp,
    expectedAt: timestamp
      .optional()
      .meta({ description: 'When preparation is now expected to finish.' }),
  }),
).meta({ id: 'PrepareLateEvent' });

// ---- Admin ------------------------------------------------------------------------------

export const SettingsChangedEventSchema = event(
  'settings.changed',
  z.object({
    key: z.string().meta({ description: 'Which settings document changed.', example: 'ranking' }),
  }),
).meta({ id: 'SettingsChangedEvent' });

export const EngineStatusEventSchema = event(
  'engine.status',
  z.object({
    engineId: z.string().meta({ example: 'home' }),
    online: z.boolean(),
    lastSeen: timestamp.nullable(),
  }),
).meta({ id: 'EngineStatusEvent' });

// ---- The union -------------------------------------------------------------------------------

export const MultitapEventSchema = z
  .discriminatedUnion('type', [
    SessionStatusEventSchema,
    SessionReadyEventSchema,
    SessionFailedEventSchema,
    SessionReleasedEventSchema,
    StreamsPartialEventSchema,
    PrepareProgressEventSchema,
    PrepareDoneEventSchema,
    PrepareLostEventSchema,
    PrepareLateEventSchema,
    SettingsChangedEventSchema,
    EngineStatusEventSchema,
  ])
  .meta({ id: 'MultitapEvent' });
export type MultitapEvent = z.infer<typeof MultitapEventSchema>;

/** One event type's full shape. */
export type MultitapEventOf<T extends EventType> = Extract<MultitapEvent, { type: T }>;

/** What a producer publishes: the event without the id and time the bus assigns. */
export type MultitapEventInput = {
  [T in EventType]: { type: T; data: MultitapEventOf<T>['data'] };
}[EventType];

/** The session an event concerns, for `?session=` filtering; undefined for others. */
export function eventSessionId(event: MultitapEvent | MultitapEventInput): string | undefined {
  const data = event.data as { sessionId?: unknown };
  return typeof data.sessionId === 'string' ? data.sessionId : undefined;
}
