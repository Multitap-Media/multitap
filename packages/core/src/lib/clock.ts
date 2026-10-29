/**
 * Returns the current time in Unix milliseconds. Injected everywhere Multitap reads
 * the time, so lifecycle, retention and token tests are deterministic (phase 2
 * conventions). Production passes `Date.now`; tests use `manualClock()` from
 * test/helpers.ts.
 */
export type Clock = () => number;

/** The real clock. */
export const systemClock: Clock = Date.now;
