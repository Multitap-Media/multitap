/**
 * Multitap's in-process event bus behind `GET /v1/events` (okf:architecture/core-events-sse).
 * {@link EventBus} is implemented by `MemoryEventBus` (events/memory-bus.ts);
 * the SSE route is http/routes/events.ts.
 *
 * Producers publish {@link MultitapEventInput}s; the bus assigns increasing ids
 * (decimal strings of a counter starting at 1) and the time from the injected
 * clock, keeps the last `MULTITAP_EVENTS_REPLAY_SIZE` events for `Last-Event-ID`, and
 * delivers synchronously to subscribers in publish order. In tests every
 * published event is validated against `MultitapEventSchema`.
 */
import type { MultitapEvent, MultitapEventInput, EventType } from '@multitap/api';

export interface EventFilter {
  /** Only events whose data has this `sessionId`. */
  sessionId?: string;
  /** Only `streams.partial` events of this source-list request (`rq_…`). */
  requestId?: string;
  /** Only these types (default: all the subscriber may see). */
  types?: readonly EventType[];
  /** Admin-only types (`settings.changed`, `engine.status`) are delivered only when true. */
  admin?: boolean;
}

export type EventListener = (event: MultitapEvent) => void;

export interface ReplayResult {
  /** Events after `lastEventId` that match the filter, oldest first. */
  events: MultitapEvent[];
  /**
   * False when `lastEventId` is older than the buffer (or unknown): events may
   * have been missed, so the client should re-read session state (okf:architecture/core-events-sse).
   */
  complete: boolean;
}

export interface EventBus {
  /** Assigns id and time, buffers, delivers; returns the stored event. */
  publish(event: MultitapEventInput): MultitapEvent;
  /** Returns an unsubscribe function. A throwing listener is logged and doesn't affect others. */
  subscribe(filter: EventFilter, listener: EventListener): () => void;
  /** Buffered events after `lastEventId` matching `filter` (for `Last-Event-ID`). */
  replay(lastEventId: string, filter: EventFilter): ReplayResult;
  /** The newest event id, or undefined before the first event. */
  readonly lastEventId: string | undefined;
  /** Current subscriber count (metrics). */
  readonly subscriberCount: number;
}
