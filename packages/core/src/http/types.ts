import type { RequestIdVariables } from 'hono/request-id';
import type { AddonService } from '../addons/index.ts';
import type { BackupService } from '../backup/service.ts';
import type { AuthVariables } from '../auth/middleware.ts';
import type { Clock } from '../auth/keys.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { EngineHealthView } from '../engines/index.ts';
import type { LibraryService } from '../library/service.ts';
import type { Logger } from '../log.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { EventBus } from '../events/bus.ts';
import type { GatewayServices } from '../gateway/services.ts';
import type { IdGenerator } from '../lib/ids.ts';
import type { SessionService } from '../sessions/service.ts';
import type { ItemMetaLookup } from '../selection/item-meta.ts';
import type { RankingSettingsStore } from '../selection/ranking-settings.ts';
import type { StreamStore } from '../selection/stream-store.ts';
import type { SubtitleService } from '../subtitles/index.ts';

/** Everything the HTTP app needs, injected so tests can supply their own. */
export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  clock: Clock;
  addons: AddonService;
  /** Raw streams behind the candidate keys handed out (okf:architecture/normalized-addon-types). */
  streams: StreamStore;
  subtitles: SubtitleService;
  /** Prometheus metrics (phase 2 step 9). */
  metrics: MetricsRegistry;
  /** Engine health checks, for `online`/`lastSeen` on engine descriptors (engines/health.ts). */
  engineHealth?: EngineHealthView;
  /**
   * Ranking settings (okf:concept/ranking-settings). Optional: without one, routes use a store over
   * `db` created on first use (http/selection-deps.ts).
   */
  ranking?: RankingSettingsStore | undefined;
  /** Item meta for ranking (okf:concept/source-ranking rules 6–7). Optional, like `ranking`. */
  itemMeta?: ItemMetaLookup | undefined;
  /** Multitap's event bus (okf:architecture/core-events-sse); `settings.changed` goes nowhere without one. */
  events?: EventBus | undefined;
  /**
   * Aborted when Multitap starts shutting down: open `/v1/events` streams end, so
   * the listener can close (okf:architecture/core-events-sse).
   */
  shutdown?: AbortSignal | undefined;
  /**
   * Profiles and libraries (okf:architecture/library-and-profiles). Optional, like `ranking`: without one,
   * the profile routes build one over `db` and the addons on first use.
   */
  library?: LibraryService | undefined;
  /**
   * Playback sessions (okf:architecture/playback-session). Optional, like `ranking`: without one, the
   * session routes build one over `db` (with the real engine transports and
   * no retention sweep) on first use (http/selection-deps.ts).
   */
  sessions?: SessionService | undefined;
  /**
   * Media tokens, viewer telemetry and session subtitles (okf:concept/media-tokens, okf:architecture/media-gateway), shared
   * with the media listener. Optional, like `sessions`: without them the
   * routes build their own on first use (http/selection-deps.ts).
   */
  gateway?: GatewayServices | undefined;
  /**
   * Database backups (okf:architecture/core-persistence). Optional, like `sessions`: without one, the
   * backup routes build one over `db` (no schedule) on first use.
   */
  backups?: BackupService | undefined;
  /** Id generation (request ids for `streams.partial`); default random. */
  ids?: IdGenerator | undefined;
}

export interface AppEnv {
  Variables: RequestIdVariables & AuthVariables;
}
