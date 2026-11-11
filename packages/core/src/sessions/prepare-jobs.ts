/**
 * Preparing `full` sessions ahead of time (okf:architecture/engine-prepare-ahead,
 * okf:process/phase-4-core-checklist): one job per session, stored in
 * `prepare_jobs`. Multitap decides when a job starts (the lead time before
 * `readyBy`), follows the engine's job, checks it again before `readyBy`, and
 * publishes the `prepare.*` events; the engine does the transcoding
 * (`/hlsv2/{id}/prepare`, upstream #73).
 *
 * A job is `scheduled` until its start, `running` while the engine's job is,
 * and `done` once the session is ready. One that can't be done fails its
 * session and leaves no job. Session status changes go through the
 * {@link PrepareHost} (the session service), so they stay serialized with
 * releases.
 */
import type { EngineStatus, MultitapEventInput } from '@multitap/api';
import type { Config } from '../config.ts';
import type { EngineHandle, EngineModule, EnginePrepareResult } from '../engines/module.ts';
import { ServerGoError, type EnginePrepareStatus } from '../engines/server-go-types.ts';
import type { EventBus } from '../events/bus.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../log.ts';
import type { PrepareJob, SessionRepository } from './repository.ts';

/** The check of a prepared session runs this long before its `readyBy`. */
export const VERIFY_BEFORE_MS = 10 * 60_000;
/** An engine job that failed, or finished with gaps, is started again this many times. */
export const MAX_JOB_RESTARTS = 1;
/** Start attempts the engine may refuse in a row before the session fails (`engine-error`). */
export const MAX_START_FAILURES = 5;
/** A job must have run this long before its rate can call it late. */
export const LATE_MIN_ELAPSED_MS = 60_000;
/** A check asked for from outside (a token mint) runs at most this often per session. */
export const VERIFY_MIN_GAP_MS = 60_000;

/** What the jobs need from the session service. */
export interface PrepareHost {
  /** The session's engine handle; undefined when it is gone, released, failed, or has none. */
  handle(sessionId: string): Promise<EngineHandle | undefined>;
  /** The session's preparation finished: `preparing` becomes `ready`. */
  prepared(sessionId: string): Promise<void>;
  /** The preparation can't be done: the session fails with `reason`. */
  failed(sessionId: string, reason: string): Promise<void>;
  /** A finished preparation was lost and is queued again: `ready` becomes `preparing`. */
  requeued(sessionId: string): Promise<void>;
}

export interface PrepareJobsOptions {
  repo: Pick<SessionRepository, 'listPrepareJobs' | 'savePrepareJob' | 'deletePrepareJob'>;
  engines: Pick<EngineModule, 'startPrepare' | 'prepareStatus'>;
  host: PrepareHost;
  config: Config['prepare'];
  clock: Clock;
  logger: Logger;
  events?: Pick<EventBus, 'publish'> | undefined;
}

/**
 * When a preparation starts: its lead time (by the source's height) before
 * `readyBy`, and at once without a `readyBy` or when that is already past.
 */
export function prepareStartAt(
  readyBy: number | null,
  height: number | null,
  leadTimeMs: Config['prepare']['leadTimeMs'],
  now: number,
): number {
  if (readyBy === null) return now;
  const lead = height !== null && height > 1080 ? leadTimeMs.above1080 : leadTimeMs.upTo1080;
  return Math.max(now, readyBy - lead);
}

/** The share of a job's segments the engine has cached, 0 to 100. */
export function preparedPct(job: Pick<PrepareJob, 'state' | 'totalSegments' | 'doneSegments'>) {
  if (job.totalSegments <= 0) return job.state === 'done' ? 100 : 0;
  const pct = (job.doneSegments / job.totalSegments) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

const iso = (ms: number) => new Date(ms).toISOString();

export class PrepareJobs {
  readonly #o: PrepareJobsOptions;
  readonly #jobs = new Map<string, PrepareJob>();
  /** Start attempts the engine refused in a row, per session. */
  readonly #startFailures = new Map<string, number>();
  /** When a session was last checked on request. */
  readonly #checked = new Map<string, number>();
  readonly #background = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(options: PrepareJobsOptions) {
    this.#o = options;
  }

  // ---- Lifecycle -------------------------------------------------------------------

  /** Reads the stored jobs; returns the sessions that have one. */
  async load(): Promise<ReadonlySet<string>> {
    this.#jobs.clear();
    for (const job of await this.#o.repo.listPrepareJobs()) this.#jobs.set(job.sessionId, job);
    return new Set(this.#jobs.keys());
  }

  /** Runs the jobs now and then every `MULTITAP_PREPARE_POLL_MS`. */
  start(): void {
    this.#stopped = false;
    this.kick();
    this.#timer = setInterval(() => {
      this.kick();
    }, this.#o.config.pollMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Resolves when no pass or check is running. */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Runs a pass in the background. */
  kick(): void {
    this.#track(this.tick());
  }

  // ---- For the session service -----------------------------------------------------

  has(sessionId: string): boolean {
    return this.#jobs.has(sessionId);
  }

  /** The session's `progress` while it has a job: the phase and `preparedPct`. */
  progress(sessionId: string): Pick<EngineStatus, 'phase' | 'preparedPct'> | undefined {
    const job = this.#jobs.get(sessionId);
    if (job === undefined) return undefined;
    return {
      phase: job.state === 'done' ? 'prepared' : 'preparing',
      preparedPct: preparedPct(job),
    };
  }

  /** Queues the preparation of a session whose source is chosen. `height` is the probe's. */
  async enqueue(
    session: { id: string; readyBy: number | null },
    height: number | undefined,
  ): Promise<void> {
    const now = this.#o.clock();
    const job: PrepareJob = {
      sessionId: session.id,
      state: 'scheduled',
      audio: this.#o.config.allAudio ? 'all' : 'default',
      height: height ?? null,
      startAt: prepareStartAt(session.readyBy, height ?? null, this.#o.config.leadTimeMs, now),
      readyBy: session.readyBy,
      startedAt: null,
      startSegments: 0,
      totalSegments: 0,
      doneSegments: 0,
      restarts: 0,
      lateNotified: false,
      verifiedAt: null,
    };
    this.#jobs.set(job.sessionId, job);
    await this.#o.repo.savePrepareJob(job, now);
    this.#o.logger.info(
      { sessionId: job.sessionId, startAt: iso(job.startAt), audio: job.audio },
      'preparation queued',
    );
  }

  /** Forgets a session's job (released or failed). The engine's job ends with its session. */
  async cancel(sessionId: string): Promise<void> {
    this.#startFailures.delete(sessionId);
    this.#checked.delete(sessionId);
    if (!this.#jobs.delete(sessionId)) return;
    await this.#o.repo.deletePrepareJob(sessionId);
  }

  /**
   * A new `readyBy` (null clears it): a job that hasn't started gets a new
   * start, and the lateness warning and the check before `readyBy` apply to
   * the new deadline.
   */
  async setReadyBy(sessionId: string, readyBy: number | null): Promise<void> {
    const job = this.#jobs.get(sessionId);
    if (job === undefined) return;
    const now = this.#o.clock();
    job.readyBy = readyBy;
    job.lateNotified = false;
    job.verifiedAt = null;
    if (job.state === 'scheduled') {
      job.startAt = prepareStartAt(readyBy, job.height, this.#o.config.leadTimeMs, now);
    }
    await this.#o.repo.savePrepareJob(job, now);
  }

  /**
   * Checks a prepared session's engine session in the background (a token is
   * being minted for it), at most every {@link VERIFY_MIN_GAP_MS}.
   */
  verify(sessionId: string): void {
    const job = this.#jobs.get(sessionId);
    if (job?.state !== 'done' || this.#stopped) return;
    const now = this.#o.clock();
    const last = this.#checked.get(sessionId);
    if (last !== undefined && now - last < VERIFY_MIN_GAP_MS) return;
    this.#checked.set(sessionId, now);
    this.#track(
      this.#verify(job, false).catch((err: unknown) => {
        this.#o.logger.warn({ err, sessionId }, 'checking a prepared session failed');
      }),
    );
  }

  // ---- The pass --------------------------------------------------------------------

  /**
   * One pass over every job: starts the ones that are due, reads the running
   * ones, checks the finished ones before their `readyBy`. Passes never
   * overlap; one asked for meanwhile runs right after.
   */
  tick(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          for (const job of [...this.#jobs.values()]) {
            if (this.#stopped) return;
            try {
              await this.#step(job);
            } catch (err) {
              this.#o.logger.error({ err, sessionId: job.sessionId }, 'preparation step failed');
            }
          }
        } while (this.#takeAgain());
      } finally {
        this.#running = undefined;
      }
    })();
    return this.#running;
  }

  /** Whether another pass was asked for while this one ran; clears the request. */
  #takeAgain(): boolean {
    const again = this.#again;
    this.#again = false;
    return again;
  }

  async #step(job: PrepareJob): Promise<void> {
    const now = this.#o.clock();
    if (job.state === 'scheduled') {
      if (now >= job.startAt) await this.#begin(job);
    } else if (job.state === 'running') {
      await this.#poll(job);
    } else if (
      job.readyBy !== null &&
      job.verifiedAt === null &&
      now >= job.readyBy - VERIFY_BEFORE_MS
    ) {
      await this.#verify(job, true);
    }
    // Not started or not finished by its deadline, whatever the rate said.
    if (this.#current(job) && job.state !== 'done') await this.#lateCheck(job, undefined);
  }

  #current(job: PrepareJob): boolean {
    return this.#jobs.get(job.sessionId) === job;
  }

  /** Starts (or starts again) the engine's job. */
  async #begin(job: PrepareJob): Promise<void> {
    const { engines, logger, clock } = this.#o;
    const handle = await this.#o.host.handle(job.sessionId);
    if (handle === undefined) {
      await this.cancel(job.sessionId);
      return;
    }
    let result: EnginePrepareResult;
    try {
      result = (await engines.startPrepare?.(handle, job.audio)) ?? { kind: 'unsupported' };
    } catch (err) {
      await this.#startRefused(job, err);
      return;
    }
    if (!this.#current(job)) return;
    switch (result.kind) {
      case 'unsupported':
        await this.#fail(job, 'prepare-unsupported');
        return;
      case 'too-large':
        await this.#fail(job, 'prepare-too-large');
        return;
      case 'no-duration':
        await this.#fail(job, 'probe-failed');
        return;
      case 'lost':
        await this.#startRefused(job, undefined);
        return;
      case 'status': {
        this.#startFailures.delete(job.sessionId);
        job.state = 'running';
        job.startedAt = clock();
        job.startSegments = result.status.cached;
        logger.info(
          { sessionId: job.sessionId, total: result.status.total, cached: result.status.cached },
          'preparation started',
        );
        await this.#apply(job, result.status, true);
      }
    }
  }

  /**
   * A start the engine didn't take. An unreachable engine is waited for (the
   * job stays due); an engine that answers but refuses counts, and after
   * {@link MAX_START_FAILURES} in a row the session fails.
   */
  async #startRefused(job: PrepareJob, err: unknown): Promise<void> {
    const { logger } = this.#o;
    if (err !== undefined && !(err instanceof ServerGoError)) {
      logger.debug({ err, sessionId: job.sessionId }, 'preparation start: engine not reachable');
      return;
    }
    const failures = (this.#startFailures.get(job.sessionId) ?? 0) + 1;
    this.#startFailures.set(job.sessionId, failures);
    logger.warn(
      {
        sessionId: job.sessionId,
        failures,
        ...(err instanceof ServerGoError ? { engineStatus: err.status } : { lost: true }),
      },
      'preparation start refused by the engine',
    );
    if (failures >= MAX_START_FAILURES && this.#current(job)) await this.#fail(job, 'engine-error');
  }

  /** Reads a running job's status. */
  async #poll(job: PrepareJob): Promise<void> {
    const handle = await this.#o.host.handle(job.sessionId);
    if (handle === undefined) {
      await this.cancel(job.sessionId);
      return;
    }
    let result: EnginePrepareResult;
    try {
      result = (await this.#o.engines.prepareStatus?.(handle)) ?? { kind: 'unsupported' };
    } catch (err) {
      this.#o.logger.debug({ err, sessionId: job.sessionId }, 'preparation status failed');
      return;
    }
    if (!this.#current(job)) return;
    if (result.kind === 'status') await this.#apply(job, result.status, false);
    else if (result.kind === 'unsupported') await this.#fail(job, 'prepare-unsupported');
    else await this.#lost(job, 'engine-session-lost');
  }

  /** Takes in the engine's status of a running job. */
  async #apply(job: PrepareJob, status: EnginePrepareStatus, started: boolean): Promise<void> {
    const { repo, clock, logger } = this.#o;
    const before = Math.floor(preparedPct(job));
    const changed =
      started || job.totalSegments !== status.total || job.doneSegments !== status.cached;
    job.totalSegments = status.total;
    job.doneSegments = status.cached;
    const counts = {
      sessionId: job.sessionId,
      total: status.total,
      cached: status.cached,
      uncached: status.uncached,
      failed: status.failed,
    };

    if (status.state === 'idle') {
      // Stopped under us: by hand, or by an engine restart that kept the session but not its job.
      await this.#lost(job, 'job-stopped');
      return;
    }
    if (status.state === 'failed' || (status.state === 'done' && status.cached < status.total)) {
      if (job.restarts < MAX_JOB_RESTARTS) {
        // Started again: the engine re-checks every segment and skips the cached ones.
        job.restarts += 1;
        job.state = 'scheduled';
        job.startAt = clock();
        logger.warn(
          { ...counts, state: status.state, engineError: status.error },
          'preparation incomplete; starting the engine job again',
        );
        await repo.savePrepareJob(job, clock());
        this.#again = true;
        return;
      }
      if (status.state === 'failed') {
        logger.warn({ ...counts, engineError: status.error }, 'preparation failed twice');
        await this.#fail(job, 'prepare-failed');
        return;
      }
      // Still gaps after the re-check: those segments are transcoded when played.
      logger.warn(counts, 'preparation finished with segments that could not be cached');
    }
    if (status.state === 'done') {
      job.state = 'done';
      await repo.savePrepareJob(job, clock());
      logger.info(counts, 'preparation done');
      this.#emit({ type: 'prepare.done', data: { sessionId: job.sessionId } });
      await this.#o.host.prepared(job.sessionId);
      return;
    }

    if (changed) await repo.savePrepareJob(job, clock());
    const pct = preparedPct(job);
    if (started || Math.floor(pct) !== before) {
      this.#emit({
        type: 'prepare.progress',
        data: { sessionId: job.sessionId, preparedPct: pct },
      });
    }
    const now = clock();
    const made = status.cached - job.startSegments;
    const elapsed = job.startedAt === null ? 0 : now - job.startedAt;
    if (made > 0 && elapsed >= LATE_MIN_ELAPSED_MS) {
      const expectedAt = now + Math.ceil(((status.total - status.cached) * elapsed) / made);
      await this.#lateCheck(job, expectedAt);
    }
  }

  /** Publishes `prepare.late` once per deadline: past it, or expected to finish after it. */
  async #lateCheck(job: PrepareJob, expectedAt: number | undefined): Promise<void> {
    if (job.readyBy === null || job.lateNotified) return;
    const now = this.#o.clock();
    if (now < job.readyBy && (expectedAt === undefined || expectedAt <= job.readyBy)) return;
    job.lateNotified = true;
    await this.#o.repo.savePrepareJob(job, now);
    this.#o.logger.warn(
      { sessionId: job.sessionId, readyBy: iso(job.readyBy), expectedAt },
      'preparation will not finish by readyBy',
    );
    this.#emit({
      type: 'prepare.late',
      data: {
        sessionId: job.sessionId,
        readyBy: iso(job.readyBy),
        ...(expectedAt === undefined ? {} : { expectedAt: iso(expectedAt) }),
      },
    });
  }

  /** A running job's engine session or job is gone: queued again from where the engine's cache is. */
  async #lost(job: PrepareJob, reason: string): Promise<void> {
    const now = this.#o.clock();
    job.state = 'scheduled';
    job.startAt = now;
    await this.#o.repo.savePrepareJob(job, now);
    this.#o.logger.warn({ sessionId: job.sessionId, reason }, 'preparation lost; queued again');
    this.#emit({ type: 'prepare.lost', data: { sessionId: job.sessionId, reason } });
    // Started again in this pass.
    this.#again = true;
  }

  /**
   * Checks a finished job against the engine: a session the engine no longer
   * has, or one with fewer cached segments than the job ended with, is queued
   * again (`prepare.lost`, and the session is `preparing` again). A job the
   * engine shows as stopped is started again quietly, which pins its segments.
   */
  async #verify(job: PrepareJob, beforeReadyBy: boolean): Promise<void> {
    const { engines, repo, clock, logger } = this.#o;
    const handle = await this.#o.host.handle(job.sessionId);
    if (handle === undefined) {
      await this.cancel(job.sessionId);
      return;
    }
    let result: EnginePrepareResult;
    try {
      result = (await engines.prepareStatus?.(handle)) ?? { kind: 'unsupported' };
    } catch (err) {
      // Unreachable: the check before `readyBy` runs again on the next pass.
      logger.debug({ err, sessionId: job.sessionId }, 'checking a prepared session failed');
      return;
    }
    if (!this.#current(job) || job.state !== 'done') return;
    if (beforeReadyBy) {
      job.verifiedAt = clock();
      await repo.savePrepareJob(job, clock());
    }
    if (result.kind === 'unsupported') {
      logger.warn({ sessionId: job.sessionId }, 'engine no longer has preparation; not checked');
      return;
    }
    let reason: string | undefined;
    if (result.kind !== 'status') reason = 'engine-session-lost';
    else if (result.status.cached < job.doneSegments) reason = 'segments-lost';
    if (reason === undefined) {
      if (result.kind === 'status' && result.status.state === 'idle') {
        await engines.startPrepare?.(handle, job.audio);
      }
      return;
    }
    const now = clock();
    job.state = 'scheduled';
    job.startAt = now;
    job.restarts = 0;
    await repo.savePrepareJob(job, now);
    logger.warn({ sessionId: job.sessionId, reason }, 'prepared session lost; queued again');
    this.#emit({ type: 'prepare.lost', data: { sessionId: job.sessionId, reason } });
    await this.#o.host.requeued(job.sessionId);
    this.#again = true;
    if (this.#running === undefined) this.kick();
  }

  async #fail(job: PrepareJob, reason: string): Promise<void> {
    await this.cancel(job.sessionId);
    await this.#o.host.failed(job.sessionId, reason);
  }

  #emit(event: MultitapEventInput): void {
    try {
      this.#o.events?.publish(event);
    } catch (err) {
      this.#o.logger.error({ err, type: event.type }, 'publishing a prepare event failed');
    }
  }

  #track(promise: Promise<unknown>): void {
    this.#background.add(promise);
    promise
      .finally(() => this.#background.delete(promise))
      .catch((err: unknown) => {
        this.#o.logger.error({ err }, 'preparation background task failed');
      });
  }
}
