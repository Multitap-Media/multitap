---
type: Component
title: "Engine session lifecycle during playback: self-heal and admission"
description: "How an engine session behaves while a viewer plays: self-healing master requests, no keepalive, no seek prewarm from core, and admission against the engine's liveConcurrency (warn, reject or off) measured as load."
tags: [core, engine, lifecycle, admission, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/engines/"
  - "packages/core/src/sessions/"
status: stable
---

Source of truth for engine session lifecycle during playback  Interface and overview: [[architecture/engine-module]].

- **Self-heal:** the gateway's master request always goes to the engine's
  `master.m3u8?mediaURL=…`. That's idempotent and cheap, and it recreates an
  evicted session (TTL or engine restart). If a player gets a 404 on a media
  playlist or segment, it reloads the master and seeks back to where it was
  (Web-app). As built, the master request carries the session's stored `mediaURL`
  and the quality the engine applied (read from `engine_sessions` after a core
  restart), so a recreated session comes back the same.
- **No keepalive.** The TTL covers pauses ([[architecture/engine-retention]]).
- **No seek prewarm from core.** The engine dedupes concurrent segment requests,
  and a client's buffering handling (a watch-party client's, for example) covers the ~1–3 s to
  transcode the first segment after a seek. Reading ahead after a seek is the
  engine's job (the transcode-ahead window, [[process/engine-upstream-prs]]), not core's.
- **Admission against `liveConcurrency`** (as built, 2026-10-01). Core never
  sent `liveConcurrency` to the engine or used it before. It counts
  simultaneous transcodes, not sessions: a paused or idle session costs the
  engine nothing, and the engine's own `STREMIO_TRANSCODE_CONCURRENCY` queues
  segment jobs rather than failing them. So core doesn't cap sessions by it.
  It measures each engine's **load**: sessions still resolving (their warm-up
  transcodes at once) plus ready sessions with a segment request through the
  gateway within `MULTITAP_ENGINE_LOAD_WINDOW_MS` (default 60 s; playlist requests and
  session reads don't count). The load and `liveConcurrency` are the
  `multitap_engine_load_sessions` and `multitap_engine_live_concurrency` gauges. When a create
  would start a new session on an engine whose load already reaches
  `liveConcurrency`, `MULTITAP_ENGINE_ADMISSION` decides: `warn` (default) logs a
  warning and goes ahead, `reject` answers `503` with a problem and
  `Retry-After` (the window, in seconds), `off` does nothing. An idempotent
  create that finds its open session is never refused. The load is in memory:
  after a core restart it counts from the next segment requests.

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
