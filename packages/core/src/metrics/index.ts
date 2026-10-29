import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

/**
 * Metrics registry for Multitap (phase 2 step 9). A per-app instance ensures test isolation.
 * Metrics cover HTTP and gateway requests, sessions by status, engine health,
 * addon outcomes, and event subscribers.
 */
export class MetricsRegistry {
  private registry: Registry;

  // HTTP API listener
  private httpRequestsTotal: Counter<'method' | 'status'>;
  private httpRequestDurationSeconds: Histogram<'method' | 'status'>;

  // Sessions
  private sessionsStatus: Gauge<'status'>;

  // Engine health
  private engineHealth: Gauge<'engine_id'>;

  // Engine load (okf:architecture/engine-session-lifecycle)
  private engineLoadSessions: Gauge<'engine_id'>;
  private engineLiveConcurrency: Gauge<'engine_id'>;

  // Addon outcomes
  private addonOutcomes: Counter<'addon_id' | 'type' | 'outcome'>;

  // Event subscribers
  private eventSubscribers: Gauge;

  // Database backups
  private backupOutcomes: Counter<'kind' | 'outcome'>;
  private backupLastSuccess: Gauge;

  // Gateway media
  private gatewayRequests: Counter<'status'>;
  private gatewayBytes: Counter<'type'>;

  constructor() {
    this.registry = new Registry();

    // HTTP request metrics
    this.httpRequestsTotal = new Counter({
      name: 'multitap_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'status'] as const,
      registers: [this.registry],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'multitap_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'status'] as const,
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    // Session status gauge
    this.sessionsStatus = new Gauge({
      name: 'multitap_sessions_status',
      help: 'Playback sessions by status',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    // Engine health gauge
    this.engineHealth = new Gauge({
      name: 'multitap_engine_health',
      help: 'Engine health status (1=online, 0=offline)',
      labelNames: ['engine_id'] as const,
      registers: [this.registry],
    });

    this.engineLoadSessions = new Gauge({
      name: 'multitap_engine_load_sessions',
      help: 'Sessions loading an engine: resolving, or ready with a segment request within MULTITAP_ENGINE_LOAD_WINDOW_MS',
      labelNames: ['engine_id'] as const,
      registers: [this.registry],
    });

    this.engineLiveConcurrency = new Gauge({
      name: 'multitap_engine_live_concurrency',
      help: "The engine descriptor's liveConcurrency (what multitap_engine_load_sessions is compared with)",
      labelNames: ['engine_id'] as const,
      registers: [this.registry],
    });

    // Addon outcomes counter
    this.addonOutcomes = new Counter({
      name: 'multitap_addon_outcomes_total',
      help: 'Addon request outcomes',
      labelNames: ['addon_id', 'type', 'outcome'] as const,
      registers: [this.registry],
    });

    // Event subscribers gauge
    this.eventSubscribers = new Gauge({
      name: 'multitap_event_subscribers',
      help: 'Current number of event subscribers',
      registers: [this.registry],
    });

    this.backupOutcomes = new Counter({
      name: 'multitap_backup_outcomes_total',
      help: 'Database backups by kind (manual, scheduled) and outcome (success, failure)',
      labelNames: ['kind', 'outcome'] as const,
      registers: [this.registry],
    });

    this.backupLastSuccess = new Gauge({
      name: 'multitap_backup_last_success_timestamp_seconds',
      help: 'Unix time of the last successful database backup (unset until one succeeds)',
      registers: [this.registry],
    });

    // Gateway metrics
    this.gatewayRequests = new Counter({
      name: 'multitap_gateway_requests_total',
      help: 'Total gateway media requests',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.gatewayBytes = new Counter({
      name: 'multitap_gateway_bytes_total',
      help: 'Total bytes served by gateway',
      labelNames: ['type'] as const,
      registers: [this.registry],
    });
  }

  /**
   * Record an HTTP request (API listener).
   */
  recordHttpRequest(method: string, status: number, durationMs: number): void {
    this.httpRequestsTotal.inc({ method, status: String(status) });
    this.httpRequestDurationSeconds.observe({ method, status: String(status) }, durationMs / 1000);
  }

  /**
   * Register or update a gauge for sessions by status.
   * Called by the session module with a function that returns the count.
   */
  registerSessionStatusGauge(status: string, getValue: () => number): void {
    this.sessionsStatus.set({ status }, getValue());
  }

  /**
   * Update session status gauge.
   */
  updateSessionStatus(status: string, value: number): void {
    this.sessionsStatus.set({ status }, value);
  }

  /**
   * Register or update a gauge for engine health.
   * Called by the engine module with a function that returns 1 (online) or 0 (offline).
   */
  registerEngineHealthGauge(engineId: string, getValue: () => number): void {
    this.engineHealth.set({ engine_id: engineId }, getValue());
  }

  /**
   * Update engine health gauge.
   */
  updateEngineHealth(engineId: string, online: boolean): void {
    this.engineHealth.set({ engine_id: engineId }, online ? 1 : 0);
  }

  /** Update an engine's load and its live concurrency (okf:architecture/engine-session-lifecycle). */
  updateEngineLoad(engineId: string, sessions: number, liveConcurrency: number): void {
    this.engineLoadSessions.set({ engine_id: engineId }, sessions);
    this.engineLiveConcurrency.set({ engine_id: engineId }, liveConcurrency);
  }

  /**
   * Record an addon outcome (catalog, meta, streams, subtitles).
   */
  recordAddonOutcome(
    addonId: string,
    type: string,
    outcome: 'success' | 'timeout' | 'error',
  ): void {
    this.addonOutcomes.inc({ addon_id: addonId, type, outcome });
  }

  /**
   * Set the current number of event subscribers.
   */
  setEventSubscribers(count: number): void {
    this.eventSubscribers.set(count);
  }

  /** Record a finished database backup; a success also sets the last-success gauge. */
  recordBackup(kind: 'manual' | 'scheduled', ok: boolean, atMs: number): void {
    this.backupOutcomes.inc({ kind, outcome: ok ? 'success' : 'failure' });
    if (ok) this.backupLastSuccess.set(Math.floor(atMs / 1000));
  }

  /**
   * Record a gateway request. Exported helper for the gateway agent to call.
   */
  recordGatewayRequest(status: number): void {
    this.gatewayRequests.inc({ status: String(status) });
  }

  /**
   * Record gateway bytes served. Exported helper for the gateway agent to call.
   */
  recordGatewayBytes(type: 'playlist' | 'segment' | 'subtitle', bytes: number): void {
    this.gatewayBytes.inc({ type }, bytes);
  }

  /**
   * Get all metrics in Prometheus text format.
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get metrics content type.
   */
  contentType(): string {
    return this.registry.contentType;
  }
}
