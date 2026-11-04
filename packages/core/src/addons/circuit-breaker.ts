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
/** The longest an addon's `Retry-After` keeps its circuit open. */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;

/**
 * One request let through by {@link CircuitBreaker.tryAcquire}. Its outcome is
 * reported with it, so the breaker can tell a current result from a stale one.
 */
export interface CircuitTicket {
  /** The breaker's period the request started in. */
  readonly period: number;
}

/**
 * A per-addon circuit breaker.
 * - closed: requests go through; `failureThreshold` consecutive failures open it.
 * - open: requests are refused until `resetMs` has passed (or longer, when the
 *   addon asked with `Retry-After`), then it's half-open.
 * - half-open: exactly one trial request goes through. Success closes the
 *   circuit, failure opens it for another `resetMs`.
 *
 * Every change of state starts a new period, and an outcome counts only for
 * the period its request started in: a request that started before the
 * circuit opened can't close it, keep it open longer or take the trial's
 * place, and only the trial decides a half-open circuit.
 */
export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #threshold: number;
  readonly #resetMs: number;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openUntil = 0;
  #period = 0;
  #trial: CircuitTicket | undefined;

  constructor(clock: Clock, options: CircuitBreakerOptions = {}) {
    this.#clock = clock;
    this.#threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#resetMs = options.resetMs ?? DEFAULT_RESET_MS;
  }

  /** The state now (an open circuit whose wait is over reads as half-open). */
  get state(): CircuitState {
    if (this.#state === 'open' && this.#clock() >= this.#openUntil) return 'half-open';
    return this.#state;
  }

  /**
   * Asks to send a request. A ticket means go ahead, and the caller must then
   * report the outcome with it: {@link success} (the addon answered, even with
   * an error such as a 404), {@link failure} (it didn't: timeout, network, 5xx,
   * 429) or {@link cancel} (the caller gave up). `undefined` means refused.
   */
  tryAcquire(): CircuitTicket | undefined {
    const state = this.state;
    if (state === 'closed') return { period: this.#period };
    if (state === 'open' || this.#trial !== undefined) return undefined;
    // Half-open: the trial gets a period of its own.
    this.#state = 'half-open';
    this.#period += 1;
    this.#trial = { period: this.#period };
    return this.#trial;
  }

  success(ticket: CircuitTicket): void {
    if (!this.#current(ticket)) return;
    if (this.#state === 'half-open') this.#close();
    else this.#failures = 0;
  }

  /**
   * @param retryAfterMs The addon's `Retry-After`: when positive, the circuit
   *   opens at once and stays open at least that long (at most
   *   {@link MAX_RETRY_AFTER_MS}).
   */
  failure(ticket: CircuitTicket, retryAfterMs?: number): void {
    if (!this.#current(ticket)) return;
    const hold =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
        : undefined;
    if (this.#state === 'half-open') {
      this.#open(Math.max(this.#resetMs, hold ?? 0));
      return;
    }
    this.#failures += 1;
    if (hold !== undefined)
      this.#open(this.#failures >= this.#threshold ? Math.max(this.#resetMs, hold) : hold);
    else if (this.#failures >= this.#threshold) this.#open(this.#resetMs);
  }

  /** The request was abandoned by the caller: no verdict, but a half-open trial slot is freed. */
  cancel(ticket: CircuitTicket): void {
    if (ticket === this.#trial) this.#trial = undefined;
  }

  /** Whether an outcome belongs to the period it is reported in. */
  #current(ticket: CircuitTicket): boolean {
    if (ticket.period !== this.#period) return false;
    // While half-open, only the trial decides; a cancelled trial decides nothing.
    return this.#state !== 'half-open' || ticket === this.#trial;
  }

  #open(forMs: number): void {
    this.#state = 'open';
    this.#openUntil = this.#clock() + forMs;
    this.#period += 1;
    this.#trial = undefined;
  }

  #close(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#period += 1;
    this.#trial = undefined;
  }
}
