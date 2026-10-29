/**
 * Playback sessions (okf:architecture/playback-session, okf:architecture/rendition-and-bandwidth, okf:decision/auto-select-and-fallback, okf:architecture/engine-retention): create (picked
 * source or auto-select with fallback), idempotency, engine choice, quality
 * caps, retention and release, with `session.*` events.
 *
 * A create answers at once with `status: 'resolving'`; the engine work runs in
 * the background and ends in `ready` (`session.ready`) or `failed`
 * (`session.failed`). Status changes of one session are serialized, so a
 * release racing a resolution never leaves an engine session behind.
 *
 * The gateway uses {@link SessionService.mediaTarget}, {@link SessionService.touch}
 * and {@link SessionService.onChange}; it never reads the raw stream.
 */
import {
  PLAYBACK_SESSION_STATUSES,
  type MultitapEventInput,
  type CreateSession,
  type EngineDescriptor,
  type EngineStatus,
  type HighResPolicy,
  type PlaybackSession,
  type ReleaseReason,
  type SessionItem,
  type SessionQuality,
  type SourceCandidate,
  type UpdateSession,
} from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';
import type { BitrateRung, Config } from '../config.ts';
import type { EngineHandle, EngineModule, PrepareResult } from '../engines/module.ts';
import { NoDefaultEngineError } from '../engines/index.ts';
import type { EventBus } from '../events/bus.ts';
import type { Clock } from '../lib/clock.ts';
import type { IdGenerator } from '../lib/ids.ts';
import type { Logger } from '../log.ts';
import type { LastSourceRecord, ProfileSelection } from '../library/service.ts';
import { bingeGroupOf, toCandidate } from '../selection/candidates.ts';
import { chooseAudioTrack, resolvePreferredLanguages } from '../selection/language.ts';
import { sortByRank } from '../selection/rank.ts';
import type { StreamStore } from '../selection/stream-store.ts';
import type { SubtitleHints } from '../subtitles/index.ts';
import { sessionIdentity } from './identity.ts';
import type { PlaybackSessionRecord, SessionRepository } from './repository.ts';
import { SubtitleHintResolver } from './subtitle-hints.ts';

/** Why a request can't be served; the route maps `code` to a status. */
export type SessionErrorCode =
  | 'not-found'
  | 'released'
  | 'candidate-expired'
  | 'candidate-mismatch'
  | 'unknown-engine'
  | 'not-implemented'
  /** `MULTITAP_ENGINE_ADMISSION=reject` and the engine is at its `liveConcurrency` (okf:architecture/engine-session-lifecycle). */
  | 'engine-busy'
  /** The request names a profile that doesn't exist. */
  | 'unknown-profile';

export class SessionError extends Error {
  override name = 'SessionError';
  readonly code: SessionErrorCode;
  /** `engine-busy`: when to try again, seconds (`Retry-After`). */
  readonly retryAfterSec: number | undefined;
  constructor(code: SessionErrorCode, message: string, retryAfterSec?: number) {
    super(message);
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/** One engine's live load (okf:architecture/engine-session-lifecycle): what admission compares with `liveConcurrency`. */
export interface EngineLoad {
  /** Sessions on the engine still resolving (their warm-up transcodes right away). */
  resolving: number;
  /** Ready sessions with a segment request within `MULTITAP_ENGINE_LOAD_WINDOW_MS`. */
  playing: number;
}

/** What the gateway gets for a session id (okf:architecture/media-gateway): serve, `410`, or `404`. */
export type MediaTarget =
  | { kind: 'ready'; session: PlaybackSessionRecord; handle: EngineHandle }
  | { kind: 'released'; session: PlaybackSessionRecord }
  /** `resolving` or `failed`: nothing to serve (yet). */
  | { kind: 'not-ready'; session: PlaybackSessionRecord }
  | { kind: 'not-found' };

/** Ranks the item's sources for an engine (auto-select, okf:decision/auto-select-and-fallback): `listSources` in production. */
export type AutoSources = (request: {
  item: SessionItem;
  engine: EngineDescriptor;
  highRes: HighResPolicy;
  /** Resolved (request > profile > instance), ISO 639-2/B, most preferred first. */
  preferredLanguages: readonly string[];
  /** The previous episode's `bingeGroup`, to rank its release up (okf:decision/auto-select-and-fallback). */
  preferBingeGroup?: string | undefined;
  /** The `sourceIdentity` the session's profile last played for the video, ranked up (okf:decision/auto-select-and-fallback). */
  lastSource?: string | undefined;
}) => Promise<SourceCandidate[]>;

/** The profile part of sessions (okf:architecture/library-and-profiles, okf:decision/auto-select-and-fallback): `LibraryService` in production. */
export interface SessionProfiles {
  /**
   * The profile's languages and last source for a video and, given the item,
   * its stored player state (P1); undefined for an unknown profile.
   */
  selection(
    profileId: string,
    videoId: string,
    itemId?: string,
  ): Promise<ProfileSelection | undefined>;
  /** Records the source a profile's session played, once ready. */
  recordLastSource(profileId: string, source: LastSourceRecord): Promise<void>;
}

export interface SessionServiceDeps {
  repo: SessionRepository;
  engines: EngineModule;
  /** Engine descriptors (capabilities for the quality caps). */
  getEngine: (id: string) => Promise<EngineDescriptor | undefined>;
  /** The engine for a request that names none; throws {@link NoDefaultEngineError} when there is none (`defaultEngineId`). */
  defaultEngine: () => Promise<string>;
  /** Raw streams behind candidate keys (okf:architecture/normalized-addon-types). */
  streams: StreamStore;
  autoSources: AutoSources;
  config: Pick<Config, 'sessions' | 'selection'> & {
    engines: Pick<Config['engines'], 'admission' | 'loadWindowMs'>;
  };
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  events?: Pick<EventBus, 'publish'> | undefined;
  /** Sessions by status (the `multitap_sessions_status` gauge) and engine load (okf:architecture/engine-session-lifecycle). */
  metrics?:
    | {
        updateSessionStatus(status: string, value: number): void;
        updateEngineLoad?(engineId: string, sessions: number, liveConcurrency: number): void;
      }
    | undefined;
  /** Profiles, for `profileId` on a create; without it such a create gets `unknown-profile`. */
  profiles?: SessionProfiles | undefined;
  /** Waits before an auto-select retry (okf:decision/auto-select-and-fallback); injected so tests don't wait. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  /**
   * The auto-select attempt timer (`MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS`): resolves
   * after `ms`, rejects when `signal` aborts. Injected so tests fire it by hand.
   */
  attemptTimer?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/** Media requests move `lastAccess` at most this often per session. */
export const TOUCH_INTERVAL_MS = 5_000;

const iso = (ms: number) => new Date(ms).toISOString();

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/**
 * A request's quality capped at the engine's `liveMaxHeight` and
 * `MULTITAP_SESSION_MAX_BITRATE` (okf:architecture/rendition-and-bandwidth): lowered, never rejected. Undefined when
 * nothing was asked.
 */
export function capQuality(
  quality: SessionQuality | undefined,
  liveMaxHeight: number,
  maxBitrate: number,
): SessionQuality | undefined {
  if (quality === undefined) return undefined;
  const out: SessionQuality = {};
  if (quality.maxHeight !== undefined) out.maxHeight = Math.min(quality.maxHeight, liveMaxHeight);
  if (quality.bitrate !== undefined) out.bitrate = Math.min(quality.bitrate, maxBitrate);
  return out.maxHeight === undefined && out.bitrate === undefined ? undefined : out;
}

/**
 * The `MULTITAP_SESSION_BITRATE_BY_HEIGHT` bitrate for an output height: the first rung
 * at or above it, else the top rung. Undefined for an empty ladder (`off`).
 */
export function bitrateForHeight(
  height: number,
  ladder: readonly BitrateRung[],
): number | undefined {
  const rung = ladder.find((r) => r.height >= height) ?? ladder.at(-1);
  return rung?.bitrate;
}

/**
 * The quality a session asks the engine for (okf:architecture/rendition-and-bandwidth): the request capped by
 * {@link capQuality}, plus, when it has `maxHeight` but no `bitrate`, a
 * bitrate derived from the capped height. A derived bitrate never exceeds
 * `MULTITAP_SESSION_MAX_BITRATE` or the engine's `defaultBitrate` (when known), so it
 * never raises what the engine would use; an explicit `bitrate` is capped at
 * `MULTITAP_SESSION_MAX_BITRATE` only. This is what idempotency compares.
 */
export function effectiveQuality(
  quality: SessionQuality | undefined,
  capabilities: Pick<EngineDescriptor['capabilities'], 'liveMaxHeight' | 'defaultBitrate'>,
  sessions: Pick<Config['sessions'], 'maxBitrate' | 'bitrateByHeight'>,
): SessionQuality | undefined {
  const capped = capQuality(quality, capabilities.liveMaxHeight, sessions.maxBitrate);
  if (capped?.maxHeight === undefined || capped.bitrate !== undefined) return capped;
  const derived = bitrateForHeight(capped.maxHeight, sessions.bitrateByHeight);
  if (derived === undefined) return capped;
  const bitrate = Math.min(
    derived,
    sessions.maxBitrate,
    capabilities.defaultBitrate ?? Number.POSITIVE_INFINITY,
  );
  return { ...capped, bitrate };
}

/** The API view of a record (`PlaybackSession`). Never includes the raw stream. */
export function sessionView(
  record: PlaybackSessionRecord,
  progress?: EngineStatus,
): PlaybackSession {
  const view: PlaybackSession = {
    id: record.id,
    item: record.item,
    source: record.source,
    delivery: record.delivery,
    mediaEntry: record.delivery === 'transcode' ? 'master.m3u8' : 'stream',
    mode: record.mode,
    highRes: record.highRes,
    status: record.status,
    tokenEpoch: record.tokenEpoch,
    createdAt: iso(record.createdAt),
    lastAccess: iso(record.lastAccess),
  };
  if (record.key !== null) view.key = record.key;
  if (record.engineId !== null) view.engineId = record.engineId;
  if (record.candidates !== null) view.candidates = record.candidates;
  if (record.chosenKey !== null) view.chosen = record.chosenKey;
  if (record.quality !== null) view.quality = record.quality;
  if (record.readyBy !== null) view.readyBy = iso(record.readyBy);
  if (record.retainUntil !== null) view.retainUntil = iso(record.retainUntil);
  if (record.failureReason !== null) view.failureReason = record.failureReason;
  if (record.bingeGroup !== null) view.bingeGroup = record.bingeGroup;
  if (record.tracks !== null) view.tracks = record.tracks;
  if (record.audioTrack !== null) view.audioTrack = record.audioTrack;
  if (record.profileId !== null) view.profileId = record.profileId;
  if (progress !== undefined) view.progress = progress;
  if (record.releasedAt !== null) view.releasedAt = iso(record.releasedAt);
  return view;
}

/** The engine handle of a session that has one. */
export function handleOf(record: PlaybackSessionRecord): EngineHandle | undefined {
  if (record.engineId === null || record.sid === null) return undefined;
  return record.quality === null
    ? { engineId: record.engineId, sid: record.sid }
    : { engineId: record.engineId, sid: record.sid, quality: record.quality };
}

/** What a ready session records as its profile's last source (addon and labels). */
type SourceOrigin = Pick<SourceCandidate, 'addonId' | 'addonName' | 'name' | 'title'>;

type Plan =
  | { kind: 'picked'; key: string; stream: Stream; origin: SourceOrigin }
  | {
      kind: 'auto';
      preferBingeGroup?: string | undefined;
      /** The profile's last source for the video (okf:decision/auto-select-and-fallback). */
      lastSource?: string | undefined;
    };

interface Job {
  controller: AbortController;
  engineId: string;
  /** Latest engine status while resolving (`progress`). */
  progress?: EngineStatus;
  /** Resolved preferred languages (request > profile > instance), for ranking and `audioTrack`. */
  preferredLanguages: readonly string[];
  /** The request's `audioLanguage`: tried first for `audioTrack`. */
  audioLanguage?: string | undefined;
}

export class SessionService {
  readonly #o: SessionServiceDeps;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #jobs = new Map<string, Job>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #ready = new Map<string, { record: PlaybackSessionRecord; handle: EngineHandle }>();
  readonly #touched = new Map<string, number>();
  /** Last segment request per session, in memory only (engine load, okf:architecture/engine-session-lifecycle). */
  readonly #played = new Map<string, number>();
  /** Engines whose load gauge has been set, so an idle one drops back to 0. */
  readonly #loadReported = new Set<string>();
  readonly #listeners = new Set<(record: PlaybackSessionRecord) => void>();
  readonly #attemptTimer: (ms: number, signal: AbortSignal) => Promise<void>;
  #subtitleHints: SubtitleHintResolver | undefined;
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<{ released: number; purged: number }> | undefined;

  constructor(deps: SessionServiceDeps) {
    this.#o = deps;
    this.#sleep = deps.sleep ?? realSleep;
    this.#attemptTimer = deps.attemptTimer ?? realSleep;
  }

  // ---- Lifecycle -------------------------------------------------------------------

  /**
   * Fails sessions a previous run left resolving, loads ready ones for the
   * gateway, sweeps once and then every `MULTITAP_RETENTION_SWEEP_MS`.
   */
  async start(): Promise<void> {
    const now = this.#o.clock();
    for (const record of await this.#o.repo.listOpen()) {
      if (record.status === 'resolving' || record.status === 'preparing') {
        const failed = await this.#o.repo.update(
          record.id,
          { status: 'failed', failureReason: 'interrupted' },
          now,
        );
        if (failed !== undefined) {
          this.#emit({
            type: 'session.failed',
            data: { sessionId: record.id, reason: 'interrupted' },
          });
        }
      } else if (record.status === 'ready') {
        this.#cache(record);
      }
    }
    this.#track(this.sweep());
    this.#timer = setInterval(() => {
      this.#track(this.sweep());
    }, this.#o.config.sessions.sweepIntervalMs);
    this.#timer.unref();
  }

  /** Stops the sweep timer and aborts resolutions in flight. */
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const job of this.#jobs.values())
      job.controller.abort(new Error('Multitap shutting down'));
  }

  /** Resolves when background work (resolutions, sweeps, metrics) has finished. */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Called with the latest record after every change (status, epoch, retention). */
  onChange(listener: (record: PlaybackSessionRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---- API -------------------------------------------------------------------------

  /**
   * `POST /v1/sessions`. Returns an open session with the same identity
   * (`created: false`) or a new one in `resolving`.
   *
   * @throws {SessionError} `not-implemented`, `candidate-expired`,
   *   `candidate-mismatch`, `unknown-engine`, `engine-busy` (admission
   *   `reject` only; an idempotent match is never refused).
   */
  async create(request: CreateSession): Promise<{ session: PlaybackSession; created: boolean }> {
    const { config } = this.#o;
    if ((request.mode ?? 'play') !== 'play' || request.readyBy !== undefined) {
      throw new SessionError(
        'not-implemented',
        "Preparation ahead of time (mode 'full', readyBy) is not built yet.",
      );
    }
    const delivery = request.delivery ?? 'auto';
    if (delivery === 'direct' || delivery === 'remux') {
      throw new SessionError(
        'not-implemented',
        `Delivery '${delivery}' is not built yet; use 'auto' or 'transcode'.`,
      );
    }

    let plan: Plan;
    let engineId: string | undefined;
    if ('key' in request.source) {
      const stored = this.#o.streams.get(request.source.key);
      if (stored === undefined) {
        throw new SessionError(
          'candidate-expired',
          'This candidate key has expired or is unknown; list the sources again.',
        );
      }
      const videoId = request.item.videoId ?? request.item.id;
      if (stored.type !== request.item.type || stored.videoId !== videoId) {
        throw new SessionError(
          'candidate-mismatch',
          "This candidate key belongs to another item's source list.",
        );
      }
      const addon = { id: stored.addonId, name: stored.addonName ?? stored.addonId };
      const origin = toCandidate(addon, stored.stream) ?? {
        addonId: addon.id,
        addonName: addon.name,
        name: '',
        title: '',
      };
      plan = { kind: 'picked', key: request.source.key, stream: stored.stream, origin };
      if (stored.flags !== undefined) {
        // An explicit choice still plays; the key is a hash, never a URL.
        this.#o.logger.warn(
          { key: request.source.key, flags: stored.flags },
          'picked source is flagged; playing it as asked',
        );
      }
      engineId = stored.requiresEngine ?? request.engine;
    } else {
      plan = { kind: 'auto', preferBingeGroup: request.source.preferBingeGroup };
      engineId = request.engine;
    }
    try {
      engineId ??= await this.#o.defaultEngine();
    } catch (err) {
      if (err instanceof NoDefaultEngineError)
        throw new SessionError('unknown-engine', err.message);
      throw err;
    }
    let profile: ProfileSelection | undefined;
    if (request.profileId !== undefined) {
      profile = await this.#o.profiles?.selection(
        request.profileId,
        request.item.videoId ?? request.item.id,
        request.item.id,
      );
      if (profile === undefined) {
        throw new SessionError('unknown-profile', `Unknown profile '${request.profileId}'.`);
      }
      if (plan.kind === 'auto') plan.lastSource = profile.lastSourceIdentity;
    }
    // Request > profile > instance default (okf:concept/source-ranking).
    const preferredLanguages = resolvePreferredLanguages({
      request: request.preferredLanguage,
      profile: profile?.preferredLanguages,
      instance: config.selection.preferredLanguage,
    });
    const engine = await this.#o.getEngine(engineId);
    if (engine === undefined)
      throw new SessionError('unknown-engine', `Unknown engine '${engineId}'.`);

    // Capped, with a bitrate derived from maxHeight when none was asked (okf:architecture/rendition-and-bandwidth).
    const requestedQuality = effectiveQuality(
      request.quality,
      engine.capabilities,
      config.sessions,
    );
    const identity = sessionIdentity({
      key: request.key,
      item: request.item,
      source: request.source,
      delivery,
      quality: requestedQuality,
      // Only the request's own list: the instance default isn't part of the identity.
      preferredLanguages: request.preferredLanguage === undefined ? undefined : preferredLanguages,
      profileId: request.profileId,
    });

    const make = async () => {
      if (identity !== null) {
        const existing = await this.#o.repo.findOpenByIdentity(identity);
        if (existing !== undefined) {
          return { session: this.#view(existing), created: false };
        }
      }
      this.#admit(engine);
      const now = this.#o.clock();
      const record = await this.#o.repo.create(
        {
          id: this.#o.ids.playbackSession(),
          key: request.key ?? null,
          item: request.item,
          source: request.source,
          identity,
          candidates: null,
          engineId: engine.id,
          delivery: 'transcode',
          mode: 'play',
          highRes: request.highRes ?? config.selection.defaultHighRes,
          requestedQuality: requestedQuality ?? null,
          readyBy: null,
          retainUntil: request.retainUntil === undefined ? null : Date.parse(request.retainUntil),
          profileId: request.profileId ?? null,
        },
        now,
      );
      // The profile's player state for the item (P1): its subtitle offset starts
      // on the chosen addon subtitle file, so it follows into a new session.
      const state = profile?.playerState;
      if (
        state?.subtitle?.kind === 'addon' &&
        state.subtitle.fileId !== undefined &&
        state.subtitleOffsetMs !== 0
      ) {
        await this.#o.repo.setSubtitleOffset(
          record.id,
          state.subtitle.fileId,
          state.subtitleOffsetMs,
        );
      }
      this.#o.logger.info(
        { sessionId: record.id, engineId: engine.id, auto: plan.kind === 'auto' },
        'playback session created',
      );
      const job: Job = {
        controller: new AbortController(),
        engineId: engine.id,
        preferredLanguages,
        // The request's, else the profile's choice for the item (P1).
        audioLanguage: request.audioLanguage ?? state?.audioLanguage ?? undefined,
      };
      this.#jobs.set(record.id, job);
      this.#emit({
        type: 'session.status',
        data: { sessionId: record.id, status: 'resolving' },
      });
      this.#track(
        this.#resolve(record, engine, plan, job).finally(() => {
          this.#jobs.delete(record.id);
          // No longer resolving: the engine load gauge drops it.
          this.#metrics();
        }),
      );
      this.#metrics();
      return { session: this.#view(record), created: true };
    };
    // Two creates with one identity: the second waits and finds the first.
    return identity === null ? make() : this.#locked(`identity:${identity}`, make);
  }

  /** `GET /v1/sessions/{id}`: the session, or undefined. A read counts as access. */
  async get(id: string): Promise<PlaybackSession | undefined> {
    const record = await this.#o.repo.get(id);
    if (record === undefined) return undefined;
    if (record.status !== 'released') {
      await this.touch(id);
    }
    return this.#view((await this.#o.repo.get(id)) ?? record);
  }

  /**
   * The `videoHash`/`videoSize`/`filename` of the session's source for subtitle
   * requests: from the stream's hints, else the engine's `/opensubHash`
   * (lazy, cached, bounded; `{}` when unknown). Never rejects.
   */
  subtitleHints(record: PlaybackSessionRecord, signal?: AbortSignal): Promise<SubtitleHints> {
    this.#subtitleHints ??= new SubtitleHintResolver({
      repo: this.#o.repo,
      engines: this.#o.engines,
      clock: this.#o.clock,
      logger: this.#o.logger,
    });
    return this.#subtitleHints.resolve(record, signal);
  }

  /** The record (no secrets), for the gateway and token routes. */
  getRecord(id: string): Promise<PlaybackSessionRecord | undefined> {
    return this.#o.repo.get(id);
  }

  /**
   * `PATCH /v1/sessions/{id}`: `retainUntil` (null clears). `readyBy` other
   * than null is phase 4.
   *
   * @throws {SessionError} `not-found`, `released`, `not-implemented`.
   */
  async update(id: string, patch: UpdateSession): Promise<PlaybackSession> {
    if (patch.readyBy !== undefined && patch.readyBy !== null) {
      throw new SessionError(
        'not-implemented',
        'readyBy needs preparation, which is not built yet.',
      );
    }
    return this.#locked(`id:${id}`, async () => {
      const record = await this.#o.repo.get(id);
      if (record === undefined) throw new SessionError('not-found', 'No session with this id.');
      if (record.status === 'released') {
        throw new SessionError('released', 'This session has been released.');
      }
      if (patch.retainUntil === undefined) return this.#view(record);
      const updated = await this.#o.repo.update(
        id,
        { retainUntil: patch.retainUntil === null ? null : Date.parse(patch.retainUntil) },
        this.#o.clock(),
      );
      if (updated === undefined) throw new SessionError('not-found', 'No session with this id.');
      this.#changed(updated);
      return this.#view(updated);
    });
  }

  /**
   * `DELETE /v1/sessions/{id}` and retention: releases the engine session and
   * marks the session `released` (kept `MULTITAP_SESSION_RELEASED_KEEP_MS` so media
   * answers `410`). Releasing a released session changes nothing.
   */
  async release(id: string, reason: ReleaseReason): Promise<PlaybackSession | undefined> {
    const record = await this.#locked(`id:${id}`, () => this.#releaseLocked(id, reason));
    return record === undefined ? undefined : this.#view(record);
  }

  async #releaseLocked(
    id: string,
    reason: ReleaseReason,
  ): Promise<PlaybackSessionRecord | undefined> {
    const record = await this.#o.repo.get(id);
    if (record === undefined || record.status === 'released') return record;
    this.#jobs.get(id)?.controller.abort(new Error('session released'));
    const handle = handleOf(record);
    if (handle !== undefined) await this.#releaseEngine(handle, id);
    const now = this.#o.clock();
    const released = await this.#o.repo.update(id, { status: 'released', releasedAt: now }, now);
    this.#ready.delete(id);
    this.#touched.delete(id);
    this.#played.delete(id);
    this.#o.logger.info({ sessionId: id, reason }, 'playback session released');
    this.#emit({ type: 'session.released', data: { sessionId: id, reason } });
    if (released !== undefined) this.#changed(released);
    this.#metrics();
    return released;
  }

  async #releaseEngine(handle: EngineHandle, sessionId: string): Promise<void> {
    try {
      await this.#o.engines.release(handle);
    } catch (err) {
      // The engine module keeps it pending; the retention sweep retries it (okf:architecture/engine-retention).
      this.#o.logger.warn(
        { err, sessionId, engineId: handle.engineId },
        'engine release failed; the retention sweep retries it',
      );
    }
  }

  /**
   * One retention pass (okf:architecture/engine-retention): releases sessions past
   * `max(retainUntil, lastAccess + MULTITAP_RETENTION_IDLE_MS)`, retries engine
   * releases that failed earlier, purges released ones older than
   * `MULTITAP_SESSION_RELEASED_KEEP_MS` and ended token revocations.
   */
  sweep(): Promise<{ released: number; purged: number }> {
    this.#sweeping ??= (async () => {
      try {
        const { repo, config, clock } = this.#o;
        const now = clock();
        const due = await repo.listDueForRelease(now, config.sessions.retentionIdleMs);
        for (const record of due) await this.release(record.id, 'retention');
        await this.#retryEngineReleases();
        const purged = await repo.purgeReleased(now - config.sessions.releasedKeepMs);
        await repo.purgeRevocations(now);
        if (due.length > 0 || purged > 0) {
          this.#o.logger.info({ released: due.length, purged }, 'retention sweep');
        }
        this.#metrics();
        return { released: due.length, purged };
      } catch (err) {
        this.#o.logger.error({ err }, 'retention sweep failed');
        return { released: 0, purged: 0 };
      } finally {
        this.#sweeping = undefined;
      }
    })();
    return this.#sweeping;
  }

  async #retryEngineReleases(): Promise<void> {
    try {
      const { released, pending } = await this.#o.engines.retryReleases();
      if (released > 0) {
        this.#o.logger.info({ released, pending }, 'engine release retries');
      } else if (pending > 0) {
        this.#o.logger.debug({ pending }, 'engine releases still pending');
      }
    } catch (err) {
      this.#o.logger.error({ err }, 'engine release retries failed');
    }
  }

  // ---- Gateway seam ----------------------------------------------------------------

  /**
   * Records access (media requests, reads) for retention. Writes at most every
   * {@link TOUCH_INTERVAL_MS} per session; never throws. `segment` (a video or
   * audio segment through the gateway) also marks the session as playing for
   * its engine's load (okf:architecture/engine-session-lifecycle); reads and playlists don't.
   */
  async touch(id: string, kind: 'read' | 'segment' = 'read'): Promise<void> {
    const now = this.#o.clock();
    if (kind === 'segment') this.#played.set(id, now);
    const last = this.#touched.get(id);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    this.#touched.set(id, now);
    try {
      await this.#o.repo.touch(id, now);
    } catch (err) {
      this.#o.logger.warn({ err, sessionId: id }, 'storing last access failed');
    }
  }

  /**
   * What the gateway serves for a session: the engine handle for a `ready`
   * one (from memory), `released` (→ `410`), `not-ready` or `not-found`
   * (→ `404`). Pass the handle to `EngineModule.fetchMedia`.
   */
  async mediaTarget(id: string): Promise<MediaTarget> {
    const cached = this.#ready.get(id);
    if (cached !== undefined) {
      return { kind: 'ready', session: cached.record, handle: cached.handle };
    }
    const record = await this.#o.repo.get(id);
    if (record === undefined) return { kind: 'not-found' };
    if (record.status === 'released') return { kind: 'released', session: record };
    const handle = record.status === 'ready' ? handleOf(record) : undefined;
    if (handle === undefined) return { kind: 'not-ready', session: record };
    this.#cache(record);
    return { kind: 'ready', session: record, handle };
  }

  /** Bumps the session's token epoch (revoke-all, okf:concept/media-tokens); undefined for an unknown session. */
  async bumpTokenEpoch(id: string): Promise<number | undefined> {
    return this.#locked(`id:${id}`, async () => {
      const epoch = await this.#o.repo.bumpTokenEpoch(id, this.#o.clock());
      if (epoch === undefined) return undefined;
      const record = await this.#o.repo.get(id);
      if (record !== undefined) {
        if (this.#ready.has(id)) this.#cache(record);
        this.#changed(record);
      }
      return epoch;
    });
  }

  // ---- Engine load (okf:architecture/engine-session-lifecycle) ------------------------------------------------------------

  /**
   * An engine's live load: sessions on it that are resolving, and ready ones
   * with a segment request within `MULTITAP_ENGINE_LOAD_WINDOW_MS`. From memory only,
   * so right after a Multitap restart it counts nothing until segments flow again.
   */
  engineLoad(engineId: string): EngineLoad {
    const since = this.#o.clock() - this.#o.config.engines.loadWindowMs;
    let resolving = 0;
    for (const job of this.#jobs.values()) {
      if (job.engineId === engineId && !job.controller.signal.aborted) resolving += 1;
    }
    let playing = 0;
    for (const [id, { record }] of this.#ready) {
      if (record.engineId !== engineId) continue;
      const at = this.#played.get(id);
      if (at !== undefined && at >= since) playing += 1;
    }
    return { resolving, playing };
  }

  /**
   * Admission (okf:architecture/engine-session-lifecycle): a new session on an engine whose load already reaches
   * its `liveConcurrency` is logged (`warn`) or refused (`reject`, `503`).
   * Concurrency counts simultaneous transcodes, so this is a soft limit:
   * paused and idle sessions don't count, and the engine queues rather than
   * fails beyond it.
   */
  #admit(engine: EngineDescriptor): void {
    const mode = this.#o.config.engines.admission;
    if (mode === 'off') return;
    const load = this.engineLoad(engine.id);
    const sessions = load.resolving + load.playing;
    const limit = engine.capabilities.liveConcurrency;
    if (sessions < limit) return;
    const fields = { engineId: engine.id, ...load, liveConcurrency: limit, admission: mode };
    if (mode === 'reject') {
      this.#o.logger.warn(fields, 'engine at its live concurrency: new session refused');
      throw new SessionError(
        'engine-busy',
        `Engine '${engine.id}' is already playing ${String(sessions)} session(s), its live concurrency (${String(limit)}). Try again later.`,
        Math.ceil(this.#o.config.engines.loadWindowMs / 1000),
      );
    }
    this.#o.logger.warn(
      fields,
      'engine at its live concurrency: the new session may make playing ones stall',
    );
  }

  /** Sets the engine load gauge for one engine. */
  #reportLoad(engine: EngineDescriptor): void {
    const metrics = this.#o.metrics;
    if (metrics?.updateEngineLoad === undefined) return;
    const load = this.engineLoad(engine.id);
    this.#loadReported.add(engine.id);
    metrics.updateEngineLoad(
      engine.id,
      load.resolving + load.playing,
      engine.capabilities.liveConcurrency,
    );
  }

  /** Refreshes the engine load gauges (every sweep), so sessions that stopped playing drop out. */
  async #reportLoads(): Promise<void> {
    if (this.#o.metrics?.updateEngineLoad === undefined) return;
    const ids = new Set(this.#loadReported);
    for (const job of this.#jobs.values()) ids.add(job.engineId);
    for (const { record } of this.#ready.values()) {
      if (record.engineId !== null) ids.add(record.engineId);
    }
    for (const id of ids) {
      const engine = await this.#o.getEngine(id);
      if (engine === undefined) {
        this.#loadReported.delete(id);
        continue;
      }
      this.#reportLoad(engine);
    }
  }

  // ---- Resolution ------------------------------------------------------------------

  async #resolve(
    record: PlaybackSessionRecord,
    engine: EngineDescriptor,
    plan: Plan,
    job: Job,
  ): Promise<void> {
    const signal = job.controller.signal;
    try {
      if (plan.kind === 'picked') {
        // A picked source has no fallback, so it keeps the engine's full timeouts.
        const result = await this.#attempt(
          record,
          engine,
          plan.key,
          plan.stream,
          job,
          job.controller.signal,
        );
        if (result.ok) {
          await this.#commitReady(record.id, plan.key, plan.stream, result, job, plan.origin);
        } else {
          await this.#commitFailed(record.id, result.reason, undefined, job);
        }
        return;
      }
      await this.#autoSelect(record, engine, job, plan.preferBingeGroup, plan.lastSource);
    } catch (err) {
      if (signal.aborted) return;
      this.#o.logger.error({ err, sessionId: record.id }, 'session resolution failed');
      await this.#commitFailed(record.id, 'internal-error', undefined, job).catch(() => undefined);
    }
  }

  /** okf:decision/auto-select-and-fallback auto-select: rank, keep the playable candidates, try in order. */
  async #autoSelect(
    record: PlaybackSessionRecord,
    engine: EngineDescriptor,
    job: Job,
    preferBingeGroup: string | undefined,
    lastSource: string | undefined,
  ) {
    const { config, clock, logger } = this.#o;
    const signal = job.controller.signal;
    // Read through a function: `aborted` changes across awaits.
    const aborted = () => signal.aborted;
    const listed = await this.#o.autoSources({
      item: record.item,
      engine,
      highRes: record.highRes,
      preferredLanguages: job.preferredLanguages,
      preferBingeGroup,
      lastSource,
    });
    if (aborted()) return;
    // Playable now: `prepared`-only sources need mode 'full' (phase 4). Flagged
    // sources (`destructive`, okf:decision/destructive-items-flagged) are never picked automatically.
    const playable = sortByRank(listed).filter((c) => c.playable && c.playableWhen !== 'prepared');
    const candidates = playable.filter((c) => c.flags === undefined);
    await this.#locked(`id:${record.id}`, async () => {
      if (aborted()) return;
      const updated = await this.#o.repo.update(record.id, { candidates }, clock());
      if (updated !== undefined) this.#changed(updated);
    });
    if (candidates.length === 0) {
      const reason = playable.length > 0 ? 'only-flagged' : 'no-candidates';
      await this.#commitFailed(record.id, reason, 0, job);
      return;
    }

    const max = config.selection.autoMaxAttempts;
    let attempts = 0;
    const retries: { candidate: SourceCandidate; stream: Stream; failedAt: number }[] = [];
    const tryOne = async (candidate: SourceCandidate, stream: Stream) => {
      attempts += 1;
      return this.#attemptLimited(record, engine, candidate.key, stream, job);
    };

    // The engine refused a torrent create at its torrent cap (and again after
    // its Retry-After): every other torrent would be refused too, so skip them
    // and try the non-torrent sources only.
    let busy = false;
    for (const candidate of candidates) {
      if (attempts >= max) break;
      if (busy && candidate.kind === 'torrent') continue;
      const stream = this.#o.streams.get(candidate.key)?.stream;
      if (stream === undefined) continue;
      const result = await tryOne(candidate, stream);
      if (aborted()) return;
      if (result.ok) {
        await this.#commitReady(record.id, candidate.key, stream, result, job, candidate);
        return;
      }
      logger.info(
        { sessionId: record.id, attempt: attempts, reason: result.reason },
        'auto-select: candidate failed',
      );
      if (result.reason === 'engine-offline') {
        await this.#commitFailed(record.id, 'engine-offline', attempts, job);
        return;
      }
      if (result.reason === 'engine-busy') {
        busy = true;
        continue;
      }
      if (result.retryable && candidate.kind === 'torrent') {
        retries.push({ candidate, stream, failedAt: clock() });
      }
    }

    // A failed torrent gets one more try after the negative-probe window, once everything after it failed too.
    for (const retry of busy ? [] : retries) {
      if (attempts >= max) break;
      const wait = retry.failedAt + config.selection.autoRetryAfterMs - clock();
      if (wait > 0) await this.#sleep(wait, signal);
      if (aborted()) return;
      const result = await tryOne(retry.candidate, retry.stream);
      if (aborted()) return;
      if (result.ok) {
        await this.#commitReady(
          record.id,
          retry.candidate.key,
          retry.stream,
          result,
          job,
          retry.candidate,
        );
        return;
      }
      if (result.reason === 'engine-offline') {
        await this.#commitFailed(record.id, 'engine-offline', attempts, job);
        return;
      }
    }
    await this.#commitFailed(
      record.id,
      busy ? 'engine-busy' : attempts >= max ? 'attempts-exhausted' : 'candidates-exhausted',
      attempts,
      job,
    );
  }

  /**
   * An auto-select attempt with `MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS` (okf:decision/auto-select-and-fallback): past
   * it, the prepare is aborted and the candidate counts as failed (retryable,
   * so a slow torrent gets its one retry), without waiting for the engine's
   * own timeouts (a dead torrent's metadata wait is minutes). A prepare that
   * still succeeds afterwards has its engine session released.
   */
  async #attemptLimited(
    record: PlaybackSessionRecord,
    engine: EngineDescriptor,
    key: string,
    stream: Stream,
    job: Job,
  ): Promise<PrepareResult | { ok: false; reason: 'attempt-timeout'; retryable: true }> {
    const timeoutMs = this.#o.config.selection.autoAttemptTimeoutMs;
    const parent = job.controller.signal;
    if (timeoutMs === null) return this.#attempt(record, engine, key, stream, job, parent);
    const attempt = new AbortController();
    const forward = () => {
      attempt.abort(parent.reason);
    };
    if (parent.aborted) forward();
    else parent.addEventListener('abort', forward, { once: true });
    const timer = new AbortController();
    const timedOut = Symbol('timed out');
    const prepared = this.#attempt(record, engine, key, stream, job, attempt.signal);
    try {
      const outcome = await Promise.race([
        prepared,
        // Rejects only when stopped below, after `prepared` has settled the race.
        this.#attemptTimer(timeoutMs, timer.signal).then((): typeof timedOut => timedOut),
      ]);
      if (outcome !== timedOut) return outcome;
      attempt.abort(new Error('auto-select attempt timed out'));
      // Settles soon (engine calls follow the signal); one that got ready anyway is released.
      this.#track(
        prepared.then(
          async (late) => {
            if (late.ok) await this.#releaseEngine(late.handle, record.id);
          },
          () => undefined,
        ),
      );
      this.#o.logger.info(
        { sessionId: record.id, timeoutMs },
        'auto-select: candidate timed out; trying the next',
      );
      return { ok: false, reason: 'attempt-timeout', retryable: true };
    } finally {
      timer.abort();
      parent.removeEventListener('abort', forward);
    }
  }

  /** Prepares one candidate on the engine, reporting progress as `session.status`. */
  #attempt(
    record: PlaybackSessionRecord,
    engine: EngineDescriptor,
    key: string,
    stream: Stream,
    job: Job,
    signal: AbortSignal,
  ): Promise<PrepareResult> {
    this.#emit({
      type: 'session.status',
      data: { sessionId: record.id, status: 'resolving', chosen: key },
    });
    return this.#o.engines.prepare({
      engineId: engine.id,
      sessionKey: record.id,
      stream,
      mode: 'play',
      ...(record.requestedQuality === null ? {} : { quality: record.requestedQuality }),
      signal,
      onStatus: (status) => {
        // An abandoned attempt (timed out, released) reports nothing more.
        if (signal.aborted) return;
        job.progress = status;
        this.#emit({
          type: 'session.status',
          data: { sessionId: record.id, status: 'resolving', progress: status, chosen: key },
        });
      },
    });
  }

  async #commitReady(
    id: string,
    key: string,
    stream: Stream,
    prepared: Extract<PrepareResult, { ok: true }>,
    job: Job,
    origin: SourceOrigin,
  ): Promise<void> {
    const { handle } = prepared;
    await this.#locked(`id:${id}`, async () => {
      if (job.controller.signal.aborted) {
        // Released while preparing: the engine session must not outlive it.
        await this.#releaseEngine(handle, id);
        return;
      }
      const now = this.#o.clock();
      const tracks = prepared.tracks ?? null;
      // The engine can't choose the default audio rendition (server-go marks the
      // file's default), so Multitap resolves the wanted language to an index the
      // client selects: the request's audioLanguage, then its preferred languages.
      const wanted =
        job.audioLanguage === undefined
          ? job.preferredLanguages
          : [job.audioLanguage, ...job.preferredLanguages];
      const audioTrack = tracks === null ? undefined : chooseAudioTrack(tracks.audio, wanted);
      await this.#o.repo.setChosen(
        id,
        {
          chosenKey: key,
          stream,
          engineId: handle.engineId,
          sid: handle.sid,
          quality: handle.quality ?? null,
          tracks,
          audioTrack: audioTrack ?? null,
          bingeGroup: bingeGroupOf(stream) ?? null,
        },
        now,
      );
      const ready = await this.#o.repo.update(id, { status: 'ready', failureReason: null }, now);
      if (ready === undefined) return;
      this.#cache(ready);
      this.#o.logger.info(
        { sessionId: id, engineId: handle.engineId, quality: handle.quality },
        'playback session ready',
      );
      this.#emit({ type: 'session.ready', data: { sessionId: id, session: this.#view(ready) } });
      this.#changed(ready);
      this.#metrics();
      if (ready.profileId !== null) await this.#recordLastSource(ready, key, stream, origin);
    });
  }

  /**
   * The profile's last source for the item (gap analysis §2.3). The identity is
   * the candidate key: a hash of the addon, the source fields and the
   * `proxyHeaders`, which any later list gives the same stream, so it needs no
   * expiry of its own. Best effort: a failure is logged and the session stays ready.
   */
  async #recordLastSource(
    record: PlaybackSessionRecord,
    key: string,
    stream: Stream,
    origin: SourceOrigin,
  ): Promise<void> {
    const profiles = this.#o.profiles;
    if (profiles === undefined || record.profileId === null) return;
    try {
      await profiles.recordLastSource(record.profileId, {
        itemId: record.item.id,
        videoId: record.item.videoId ?? record.item.id,
        sourceIdentity: key,
        addonId: origin.addonId,
        addonName: origin.addonName,
        name: origin.name,
        title: origin.title,
        bingeGroup: bingeGroupOf(stream),
      });
    } catch (err) {
      this.#o.logger.warn(
        { err, sessionId: record.id, profileId: record.profileId },
        "recording the profile's last source failed",
      );
    }
  }

  async #commitFailed(
    id: string,
    reason: string,
    attempts: number | undefined,
    job: Job,
  ): Promise<void> {
    await this.#locked(`id:${id}`, async () => {
      if (job.controller.signal.aborted) return;
      const failed = await this.#o.repo.update(
        id,
        { status: 'failed', failureReason: reason },
        this.#o.clock(),
      );
      if (failed === undefined) return;
      this.#o.logger.info({ sessionId: id, reason, attempts }, 'playback session failed');
      this.#emit({
        type: 'session.failed',
        data:
          attempts === undefined ? { sessionId: id, reason } : { sessionId: id, reason, attempts },
      });
      this.#changed(failed);
      this.#metrics();
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  #view(record: PlaybackSessionRecord): PlaybackSession {
    let progress: EngineStatus | undefined;
    if (record.status === 'resolving') {
      progress = this.#jobs.get(record.id)?.progress;
    } else if (record.status === 'ready') {
      const handle = handleOf(record);
      if (handle !== undefined) progress = this.#o.engines.status(handle);
    }
    return sessionView(record, progress);
  }

  #cache(record: PlaybackSessionRecord): void {
    const handle = handleOf(record);
    if (record.status === 'ready' && handle !== undefined) {
      this.#ready.set(record.id, { record, handle });
    } else {
      this.#ready.delete(record.id);
    }
  }

  #changed(record: PlaybackSessionRecord): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(record);
      } catch (err) {
        this.#o.logger.warn({ err, sessionId: record.id }, 'session change listener threw');
      }
    }
  }

  #emit(event: MultitapEventInput): void {
    try {
      this.#o.events?.publish(event);
    } catch (err) {
      this.#o.logger.error({ err, type: event.type }, 'publishing a session event failed');
    }
  }

  /** Refreshes the `multitap_sessions_status` and engine load gauges in the background. */
  #metrics(): void {
    const metrics = this.#o.metrics;
    if (metrics === undefined) return;
    this.#track(
      this.#reportLoads().catch((err: unknown) => {
        this.#o.logger.warn({ err }, 'reporting engine load failed');
      }),
    );
    this.#track(
      this.#o.repo.countByStatus().then(
        (counts) => {
          for (const status of PLAYBACK_SESSION_STATUSES) {
            metrics.updateSessionStatus(status, counts.get(status) ?? 0);
          }
        },
        (err: unknown) => {
          this.#o.logger.warn({ err }, 'counting sessions failed');
        },
      ),
    );
  }

  /** Runs `fn` after every earlier call with the same key has settled. */
  #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  #track(promise: Promise<unknown>): void {
    this.#background.add(promise);
    promise
      .finally(() => this.#background.delete(promise))
      .catch((err: unknown) => {
        this.#o.logger.error({ err }, 'session background task failed');
      });
  }
}
