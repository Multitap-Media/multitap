/**
 * The subtitle hint resolver's shared engine lookup (okf:architecture/core-subtitles-and-player-state):
 * callers share one `/opensubHash` read, bounded by its own timeout only, so
 * one caller going away neither ends it for the others nor caches a miss.
 */
import { describe, expect, it } from 'vitest';
import type { EngineHandle } from '../src/engines/module.ts';
import type { PlaybackSessionRecord } from '../src/sessions/repository.ts';
import { SubtitleHintResolver } from '../src/sessions/subtitle-hints.ts';
import { manualClock, memoryLogger } from './helpers.ts';

const RECORD = {
  id: 'ps_1',
  status: 'ready',
  engineId: 'home',
  sid: 'E1',
} as PlaybackSessionRecord;

const HASH = { hash: '0123456789abcdef', size: 42 };

function setup() {
  const signals: AbortSignal[] = [];
  let answer: (value: typeof HASH) => void = () => undefined;
  const resolver = new SubtitleHintResolver({
    repo: { getStream: () => Promise.resolve(undefined) },
    engines: {
      // Like the real read: it fails as soon as its signal aborts.
      openSubHash: (_handle: EngineHandle, signal?: AbortSignal) =>
        new Promise<typeof HASH>((resolve, reject) => {
          if (signal !== undefined) signals.push(signal);
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
          answer = resolve;
        }),
    },
    clock: manualClock(),
    logger: memoryLogger().logger,
    timeoutMs: 60_000,
  });
  return {
    resolver,
    signals,
    answer: (value: typeof HASH) => {
      answer(value);
    },
  };
}

describe('SubtitleHintResolver', () => {
  it('a caller going away stops only its own wait; the shared lookup goes on and is cached', async () => {
    const { resolver, signals, answer } = setup();
    const gone = new AbortController();
    const first = resolver.resolve(RECORD, gone.signal);
    const second = resolver.resolve(RECORD, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gone.abort();
    expect(await first).toEqual({});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    answer(HASH);
    expect(await second).toEqual({ videoHash: HASH.hash, videoSize: HASH.size });
    // Found, so cached: no second engine read.
    expect(await resolver.resolve(RECORD)).toEqual({ videoHash: HASH.hash, videoSize: HASH.size });
    expect(signals).toHaveLength(1);
  });

  it('a caller already gone gets {} at once, and its abort is no cached miss', async () => {
    const { resolver, signals, answer } = setup();
    expect(await resolver.resolve(RECORD, AbortSignal.abort())).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer(HASH);
    expect(await resolver.resolve(RECORD)).toEqual({ videoHash: HASH.hash, videoSize: HASH.size });
    expect(signals).toHaveLength(1);
  });
});
