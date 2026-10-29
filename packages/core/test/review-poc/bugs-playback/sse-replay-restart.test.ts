/**
 * Review PoC (bugs-playback): event ids restart at 1 when Multitap restarts, so a
 * client resuming with a `Last-Event-ID` from the previous run is told the
 * replay is `complete` as soon as the new run has issued that many events, and
 * silently misses the new run's earlier events (here a `session.failed`).
 */
import { expect, it } from 'vitest';
import { MemoryEventBus } from '../../../src/events/memory-bus.ts';

const clock = () => Date.parse('2026-10-20T00:00:00Z');

it.fails(
  'a Last-Event-ID from before a restart never yields a complete replay that skips events',
  () => {
    // Run 1: the client saw events up to id 5.
    const before = new MemoryEventBus({ clock, replaySize: 100 });
    for (let i = 0; i < 5; i++) {
      before.publish({ type: 'session.status', data: { sessionId: 'ps_a', status: 'resolving' } });
    }
    const clientLast = before.lastEventId; // '5'
    if (!clientLast) throw new Error('expected a last event id');

    // Multitap restarts; the new run publishes 8 events before the client reconnects.
    const after = new MemoryEventBus({ clock, replaySize: 100 });
    after.publish({
      type: 'session.failed',
      data: { sessionId: 'ps_mine', reason: 'interrupted' },
    });
    for (let i = 0; i < 7; i++) {
      after.publish({ type: 'session.status', data: { sessionId: 'ps_b', status: 'resolving' } });
    }

    const replay = after.replay(clientLast, { sessionId: 'ps_mine' });
    // Either the replay says partial (so the client re-reads state), or it includes the failure.
    const sawFailure = replay.events.some((e) => e.type === 'session.failed');
    expect(!replay.complete || sawFailure).toBe(true);
  },
);
