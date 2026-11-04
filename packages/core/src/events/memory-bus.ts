/**
 * The in-process {@link EventBus} (okf:architecture/core-events-sse): increasing decimal ids
 * from 1, the time from the injected clock, a bounded replay buffer for
 * `Last-Event-ID`, and synchronous delivery in publish order.
 *
 * Ids restart at 1 when Multitap restarts. A client resuming with an id the bus
 * never issued (or one older than the buffer) gets everything buffered and an
 * incomplete replay, and re-reads session state (okf:architecture/core-events-sse).
 */
import {
  ADMIN_EVENT_TYPES,
  MultitapEventSchema,
  eventSessionId,
  type MultitapEvent,
  type MultitapEventInput,
} from '@multitap/api';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../log.ts';
import type { EventBus, EventFilter, EventListener, ReplayResult } from './bus.ts';

export interface MemoryEventBusOptions {
  clock: Clock;
  /** Events kept for replay (`MULTITAP_EVENTS_REPLAY_SIZE`); 0 keeps none. */
  replaySize: number;
  logger?: Logger | undefined;
  /** Validate every published event against `MultitapEventSchema` and throw on a mismatch (tests). */
  validate?: boolean | undefined;
  /** Told the subscriber count whenever it changes (the `multitap_event_subscribers` gauge). */
  onSubscribers?: ((count: number) => void) | undefined;
}

const ADMIN_ONLY: ReadonlySet<string> = new Set(ADMIN_EVENT_TYPES);

/** Whether `event` passes `filter`. */
export function matchesFilter(event: MultitapEvent, filter: EventFilter): boolean {
  if (ADMIN_ONLY.has(event.type) && filter.admin !== true) return false;
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  if (filter.sessionId !== undefined && eventSessionId(event) !== filter.sessionId) return false;
  if (filter.requestId !== undefined) {
    if (event.type !== 'streams.partial' || event.data.requestId !== filter.requestId) return false;
  }
  return true;
}

interface Subscription {
  filter: EventFilter;
  listener: EventListener;
}

export class MemoryEventBus implements EventBus {
  readonly #o: MemoryEventBusOptions;
  /**
   * The replay buffer, a ring of `replaySize` slots: the oldest event at
   * `#start`, `#size` of them in id order. Ids in it are consecutive.
   */
  readonly #ring: (MultitapEvent | undefined)[];
  #start = 0;
  #size = 0;
  readonly #subscriptions = new Set<Subscription>();
  #counter = 0;

  constructor(options: MemoryEventBusOptions) {
    this.#o = options;
    this.#ring = new Array<MultitapEvent | undefined>(Math.max(0, options.replaySize));
  }

  get lastEventId(): string | undefined {
    return this.#counter === 0 ? undefined : String(this.#counter);
  }

  get subscriberCount(): number {
    return this.#subscriptions.size;
  }

  publish(input: MultitapEventInput): MultitapEvent {
    const candidate = {
      id: String(this.#counter + 1),
      at: new Date(this.#o.clock()).toISOString(),
      type: input.type,
      data: input.data,
    } as MultitapEvent;
    // Validation throws before the id is used, so a rejected event leaves no gap.
    const event = this.#o.validate === true ? MultitapEventSchema.parse(candidate) : candidate;
    this.#counter += 1;
    this.#buffer(event);
    for (const subscription of [...this.#subscriptions]) {
      if (!matchesFilter(event, subscription.filter)) continue;
      try {
        subscription.listener(event);
      } catch (err) {
        this.#o.logger?.warn({ err, type: event.type }, 'event listener threw');
      }
    }
    return event;
  }

  subscribe(filter: EventFilter, listener: EventListener): () => void {
    const subscription: Subscription = { filter, listener };
    this.#subscriptions.add(subscription);
    this.#o.onSubscribers?.(this.#subscriptions.size);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscriptions.delete(subscription);
      this.#o.onSubscribers?.(this.#subscriptions.size);
    };
  }

  replay(lastEventId: string, filter: EventFilter): ReplayResult {
    if (!/^\d{1,15}$/.test(lastEventId)) return { events: this.#since(0, filter), complete: false };
    const last = Number(lastEventId);
    // An id this bus never issued: from before a restart.
    if (last > this.#counter) return { events: this.#since(0, filter), complete: false };
    const oldest = this.#size === 0 ? undefined : this.#ring[this.#start];
    const oldestId = oldest === undefined ? this.#counter + 1 : Number(oldest.id);
    // Everything after `last` is still buffered when `last` is the newest
    // id, or the buffer starts at (or before) the event right after it.
    const complete = last === this.#counter || (oldest !== undefined && oldestId <= last + 1);
    // Ids are consecutive, so the events after `last` start at a known slot.
    return { events: this.#since(Math.max(0, last + 1 - oldestId), filter), complete };
  }

  /** Keeps `event` for replay, dropping the oldest once full. */
  #buffer(event: MultitapEvent): void {
    const capacity = this.#ring.length;
    if (capacity === 0) return;
    if (this.#size < capacity) {
      this.#ring[(this.#start + this.#size) % capacity] = event;
      this.#size += 1;
    } else {
      this.#ring[this.#start] = event;
      this.#start = (this.#start + 1) % capacity;
    }
  }

  /** Buffered events from the `from`-th oldest on that match `filter`, oldest first. */
  #since(from: number, filter: EventFilter): MultitapEvent[] {
    const events: MultitapEvent[] = [];
    const capacity = this.#ring.length;
    for (let i = from; i < this.#size; i++) {
      const event = this.#ring[(this.#start + i) % capacity];
      if (event !== undefined && matchesFilter(event, filter)) events.push(event);
    }
    return events;
  }
}
