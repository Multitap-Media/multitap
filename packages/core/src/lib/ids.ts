/**
 * Id generation, injected like the clock so tests get predictable ids (phase 2
 * conventions). Production uses {@link randomIds}; tests use
 * {@link sequentialIds}.
 */
import { randomBytes } from 'node:crypto';

export interface IdGenerator {
  /** A playback session id: `ps_` + 22 base64url characters (okf:architecture/playback-session). */
  playbackSession(): string;
  /** An engine session id (`sid`): 22 base64url characters, 128 bits (okf:architecture/engine-prepare-stream). */
  engineSession(): string;
  /** A profile id: `pr_` + 22 base64url characters (okf:architecture/library-and-profiles). */
  profile(): string;
  /** A request id for incremental source lists (`streams.partial`, okf:concept/addon-aggregation): `rq_` + 22 characters. */
  request(): string;
}

/** 16 random bytes as base64url: always 22 characters. */
export function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

export const randomIds: IdGenerator = {
  playbackSession: () => `ps_${randomToken()}`,
  engineSession: randomToken,
  profile: () => `pr_${randomToken()}`,
  request: () => `rq_${randomToken()}`,
};

/**
 * Deterministic ids for tests, in the production formats: `ps_` + a counter
 * padded to 22 characters, and so on. Each kind counts from 1.
 */
export function sequentialIds(): IdGenerator {
  const counters = { ps: 0, sid: 0, pr: 0, rq: 0 };
  const next = (kind: keyof typeof counters, letter: string) => {
    counters[kind] += 1;
    return `${letter}${String(counters[kind]).padStart(22 - letter.length, '0')}`;
  };
  return {
    playbackSession: () => `ps_${next('ps', 'S')}`,
    engineSession: () => next('sid', 'E'),
    profile: () => `pr_${next('pr', 'P')}`,
    request: () => `rq_${next('rq', 'R')}`,
  };
}
