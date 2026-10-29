import type { Clock } from '../auth/keys.ts';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long an open circuit refuses requests before one trial is let through. Default 60 s. */
  resetMs?: number;
}

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_RESET_MS = 60_000;

/**
 * A per-addon circuit breaker.
 * - closed: requests go through; `failureThreshold` consecutive failures open it.
 * - open: requests are refused until `resetMs` has passed, then it's half-open.
 * - half-open: exactly one trial request goes through. Success closes the
 *   circuit, failure opens it for another `resetMs`.
 */
export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #threshold: number;
  readonly #resetMs: number;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #trialInFlight = false;

  constructor(clock: Clock, options: CircuitBreakerOptions = {}) {
    this.#clock = clock;
    this.#threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#resetMs = options.resetMs ?? DEFAULT_RESET_MS;
  }

  /** The state now (an open circuit whose wait is over reads as half-open). */
  get state(): CircuitState {
    if (this.#state === 'open' && this.#clock() - this.#openedAt >= this.#resetMs) {
      return 'half-open';
    }
    return this.#state;
  }

  /**
   * Asks to send a request. `true` means go ahead, and the caller must then
   * report the outcome with {@link success} (the addon answered, even with an
   * error such as a 404) or {@link failure} (it didn't: timeout, network, 5xx).
   */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.#trialInFlight) return false;
    this.#state = 'half-open';
    this.#trialInFlight = true;
    return true;
  }

  success(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#trialInFlight = false;
  }

  failure(): void {
    this.#trialInFlight = false;
    if (this.#state === 'half-open') {
      this.#open();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.#threshold) this.#open();
  }

  /** The request was abandoned by the caller: no verdict, but a half-open trial slot is freed. */
  cancel(): void {
    this.#trialInFlight = false;
  }

  #open(): void {
    this.#state = 'open';
    this.#openedAt = this.#clock();
  }
}
