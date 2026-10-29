/**
 * Playback-session test rig: an in-memory database with the `home` engine on
 * the fake engine, the real engine module and session service, a validating
 * event bus that records every event, and an app over all of it. Injected
 * clock, ids and retry sleep; no ffmpeg, no network.
 */
import {
  MultitapEventSchema,
  DEFAULT_RANKING_SETTINGS,
  type MultitapEvent,
  type EngineCapabilities,
  type SourceCandidate,
} from '@multitap/api';
import type { Stream } from '@multitap/addon-protocol';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey, type ApiKeyScope } from '../src/auth/keys.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Db } from '../src/db/index.ts';
import { ServerGoEngineModule } from '../src/engines/engine-module.ts';
import { defaultEngineId, getEngine, putEngine } from '../src/engines/index.ts';
import { HOME_ENGINE, PUBLIC_DNS_GUARD } from './engine-fixture.ts';
import { createLanTransport } from '../src/engines/lan-transport.ts';
import { EngineRegistry } from '../src/engines/registry.ts';
import { MemoryEventBus } from '../src/events/memory-bus.ts';
import { createApp, type AppDeps } from '../src/http/app.ts';
import { sequentialIds } from '../src/lib/ids.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { toCandidates } from '../src/selection/candidates.ts';
import { annotate } from '../src/selection/rank.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SessionService, type AutoSources } from '../src/sessions/service.ts';
import { SqliteSessionRepository } from '../src/sessions/sqlite-repository.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { FakeEngine, type FakeEngineOptions } from './fakes/engine.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

export const MOVIE = { type: 'movie', id: 'tt0000001' } as const;
export const IH_GOOD = '1111111111111111111111111111111111111111';
export const IH_DEAD = '2222222222222222222222222222222222222222';

/** A direct HTTP stream (placeholder host; the fake engine never fetches it). */
export const httpStream = (name: string): Stream =>
  ({ url: `https://media.example/${name}.mkv`, name: 'Fake', title: `${name} 1080p` }) as Stream;

export const torrentStream = (infoHash: string): Stream =>
  ({ infoHash, fileIdx: 0, name: 'Fake', title: 'Movie.2026.1080p.mkv' }) as Stream;

export interface RigOptions {
  fake?: FakeEngineOptions;
  caps?: Partial<EngineCapabilities>;
  env?: Record<string, string>;
  /** Reach the fake engine over real HTTP (the `lan` transport) instead of in-process. */
  realEngine?: boolean;
}

export interface Rig {
  db: Db;
  fake: FakeEngine;
  clock: ReturnType<typeof manualClock>;
  config: Config;
  streams: StreamStore;
  bus: MemoryEventBus;
  events: MultitapEvent[];
  repo: SqliteSessionRepository;
  module: ServerGoEngineModule;
  service: SessionService;
  metrics: MetricsRegistry;
  log: ReturnType<typeof memoryLogger>;
  /** Candidates auto-select gets, in the order given (scores descending). */
  autoList: SourceCandidate[];
  /** Waits requested by auto-select's retry, ms. */
  sleeps: number[];
  /** Runs before each retry wait returns (e.g. to give a torrent peers). */
  onSleep: (() => void) | undefined;
  /** Auto-select attempt timers started and not yet stopped; `fire()` makes one run out. */
  attemptTimers: { ms: number; fire: () => void }[];
  /** Lists a stream for the item; returns its candidate key. */
  list: (stream: Stream, item?: { type: string; id: string; videoId?: string }) => string;
  /** Adds candidates for auto-select (each also listed), best first. */
  auto: (...streams: Stream[]) => SourceCandidate[];
  app: ReturnType<typeof createApp>;
  appDeps: AppDeps;
  addons: AddonService;
  keyFor: (scope: ApiKeyScope) => Promise<string>;
  /** Waits for every background resolution. */
  settle: () => Promise<void>;
}

export async function sessionRig(options: RigOptions = {}): Promise<Rig> {
  const db = await migratedMemoryDb();
  await putEngine(db, 'home', {
    ...HOME_ENGINE,
    address: 'http://engine.test:11470',
    capabilities: { ...HOME_ENGINE.capabilities, ...options.caps },
  });
  const fake = new FakeEngine({
    torrents: {
      [IH_GOOD]: { files: [{ name: 'Movie.2026.1080p.mkv', length: 5_000 }], peers: 3 },
    },
    ...options.fake,
  });
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '2000',
    MULTITAP_ADDON_TIMEOUT_META_MS: '2000',
    ...options.env,
  });
  const ids = sequentialIds();
  const engineBase = options.realEngine === true ? await fake.listen() : undefined;
  const registry = new EngineRegistry({
    db,
    timeouts: { control: 2_000, prepare: 2_000, media: 2_000 },
    transportFactory: () =>
      engineBase === undefined
        ? fake.transport('home')
        : createLanTransport({ id: 'home', address: engineBase }),
  });
  const module = new ServerGoEngineModule({
    db,
    registry,
    logger: log.logger,
    clock,
    ids,
    privateHosts: PUBLIC_DNS_GUARD,
    warmSegments: 0,
    busyRetryMaxMs: 0,
  });
  const streams = new StreamStore({ clock });
  const events: MultitapEvent[] = [];
  const bus = new MemoryEventBus({ clock, replaySize: 100, logger: log.logger, validate: true });
  bus.subscribe({ admin: true }, (event) => {
    // The bus validated it already; this is the test's own check.
    events.push(MultitapEventSchema.parse(event));
  });
  const repo = new SqliteSessionRepository(db);
  const metrics = new MetricsRegistry();
  const rig = {
    autoList: [] as SourceCandidate[],
    sleeps: [] as number[],
    onSleep: undefined as (() => void) | undefined,
    attemptTimers: [] as { ms: number; fire: () => void }[],
  };
  const autoSources: AutoSources = () => Promise.resolve(rig.autoList);
  const service = new SessionService({
    repo,
    engines: module,
    getEngine: (id) => getEngine(db, id),
    defaultEngine: () => defaultEngineId(db, config.selection.defaultEngine),
    streams,
    autoSources,
    config,
    clock,
    ids,
    logger: log.logger,
    events: bus,
    metrics,
    sleep: (ms) => {
      rig.sleeps.push(ms);
      clock.advance(ms);
      rig.onSleep?.();
      return Promise.resolve();
    },
    // Never runs out by itself: a test fires it (and advances the clock) by hand.
    attemptTimer: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timers = rig.attemptTimers;
        const entry = {
          ms,
          fire: () => {
            timers.splice(timers.indexOf(entry), 1);
            clock.advance(ms);
            resolve();
          },
        };
        timers.push(entry);
        signal.addEventListener(
          'abort',
          () => {
            const i = timers.indexOf(entry);
            if (i >= 0) timers.splice(i, 1);
            reject(signal.reason as Error);
          },
          { once: true },
        );
      }),
  });

  let counter = 0;
  const list: Rig['list'] = (stream, item = MOVIE) => {
    const [built] = toCandidates({ id: 'fake-addon', name: 'Fake' }, [stream], { type: item.type });
    if (built === undefined) throw new Error('stream has no usable source');
    streams.put(built.candidate.key, {
      addonId: 'fake-addon',
      type: item.type,
      videoId: item.videoId ?? item.id,
      stream,
    });
    return built.candidate.key;
  };
  const auto: Rig['auto'] = (...list_) => {
    const engine = { id: 'home', capabilities: { ...HOME_ENGINE.capabilities, ...options.caps } };
    const made = list_.map((stream) => {
      list(stream);
      const [built] = toCandidates({ id: 'fake-addon', name: 'Fake' }, [stream], { type: 'movie' });
      return (built as { candidate: SourceCandidate }).candidate;
    });
    const annotated = annotate(made, engine, 'off', { settings: DEFAULT_RANKING_SETTINGS }).map(
      (candidate, i) => {
        counter += 1;
        return { ...candidate, score: 10_000 - i - counter };
      },
    );
    rig.autoList.push(...annotated);
    return annotated;
  };

  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const appDeps: AppDeps = {
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams,
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics,
    events: bus,
    sessions: service,
    ids,
  };
  const app = createApp(appDeps);
  const keyFor = async (scope: ApiKeyScope) =>
    (await createApiKey(db, { scope, label: `test ${scope}` }, clock)).key;
  const settle = async () => {
    await service.idle();
    await module.idle();
  };

  return Object.assign(rig, {
    db,
    fake,
    clock,
    config,
    streams,
    bus,
    events,
    repo,
    module,
    service,
    metrics,
    log,
    list,
    auto,
    app,
    appDeps,
    addons,
    keyFor,
    settle,
  });
}
