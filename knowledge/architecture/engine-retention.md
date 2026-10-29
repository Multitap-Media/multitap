---
type: Component
title: "Engine session retention: policy, release and pending-release retries"
description: "Retention policy in core (max of retainUntil and lastAccess plus idle), how upstream #24 and #25 change enforcement, the sweep as built, release racing a resolution, retried pending releases (R27), and the optional per-session ttl."
tags: [core, engine, retention, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/engines/"
  - "packages/core/src/sessions/"
status: stable
---

Source of truth for engine session retention  Interface and overview: [[architecture/engine-module]].

- **Policy lives in core:**
  - A session is kept until `max(retainUntil, lastAccess + retention.idle)`,
    with `retention.idle = 1h` by default.
  - `DELETE /v1/sessions/{id}` releases it immediately.
  - Clients set `retainUntil` for their own reasons. The client sets it to six hours
    after a party ends (a watch-party client).
- **With #24** (`DELETE /hlsv2/{id}`), `release()` implements the policy
  exactly, and the TTL drops back to being a safety net. The reference engine runs
  `STREMIO_HLS_SESSION_TTL=0` (never evict) and relies on core's deletes.
- **With #25** (per-session `ttl`, gate `STREMIO_HLS_SESSION_OVERRIDES=1`), core
  can also give a session its own TTL, set when it creates the session or
  extended by re-requesting the master with a new `ttl`. A per-session `ttl`
  wins over `STREMIO_HLS_SESSION_TTL=0`: that session is still evicted on its
  own schedule, so core uses it only as a safety net for sessions it might fail
  to delete. Every client that can reach the engine is core, so the gate's trust
  requirement is met.
- **On an engine without #24**, enforcement is only server-go's global TTL. It
  must cover the longest gap between last access and use, which is the 4K lead
  time: `STREMIO_HLS_SESSION_TTL=48h`. Every idle session, prepared or not, then
  stays on disk for up to 48 h after its last access. Size the disk for that
  (Reference engine configuration).

**As built in phase 2:**
- The sweep runs every `MULTITAP_RETENTION_SWEEP_MS` (and at startup). It releases every
  session that isn't `released` and is past
  `max(retainUntil, lastAccess + MULTITAP_RETENTION_IDLE_MS)`, `failed` ones included,
  and deletes released sessions `MULTITAP_SESSION_RELEASED_KEEP_MS` after release; until
  then their media answers `410`, afterwards `404`. `lastAccess` moves on media
  requests and session reads, written at most every 5 s per session.
- Release aborts a resolution in flight, then calls the engine module's
  `release()`: `DELETE /hlsv2/{sid}` where the engine has it ([[architecture/engine-endpoints-core-uses]]), then it
  deletes the `engine_sessions` row. A release racing a resolution never leaves
  an engine session behind.
- **A release the engine doesn't confirm is retried** (R27). When the `DELETE`
  fails (the engine is unreachable, or answers with an unexpected status), core
  logs a warning and marks the playback session released as before, but keeps
  the `engine_sessions` row as a *pending release* (`release_pending_since`,
  `release_attempts`, `release_next_at`). Every sweep retries the due ones,
  skipping engines the health check sees offline, with a backoff that starts
  at `MULTITAP_RETENTION_SWEEP_MS` and doubles up to `MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS`.
  `204` and `404` (already gone, e.g. after an engine restart without
  persistence) both end it, as do an engine without `DELETE` and a removed
  engine; only then is the row (and its `mediaURL`) deleted. Pending releases
  are in the database, so they survive a core restart. If the playback
  session's engine session is prepared again first, the pending release is
  cancelled.
- **Per-session `ttl`, optional:** `MULTITAP_ENGINE_SESSION_TTL_MS` (unset by default,
  so behaviour is unchanged) is sent as #25's `ttl` on every master request to
  an engine with `sessionOverrides`, as the safety net above for a session core
  never manages to delete. It must be at least `MULTITAP_RETENTION_IDLE_MS`; size it
  above the longest `retainUntil` clients use (e.g. `48h`), since the engine
  evicts a session idle that long even when core still keeps it (self-heal
  then recreates it, at the cost of a fresh transcode).

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
