---
type: Component
title: "Preparing ahead: lead times, who does what, verification (phase 4, not built)"
description: "Planned preparation of a full-mode session by its readyBy: lead times by source height, the engine-side versus core-driven paths, verification at readyBy minus 10 minutes, uncached segments, and progress reporting."
tags: [core, engine, prepare, planned, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/engines/"
status: draft
---

Source of truth for preparing ahead  Interface and overview: [[architecture/engine-module]].

- **When:** a session with `mode: 'full'` is prepared so that it's done by its
  `readyBy`. `prepareJobs` works out the start time from a configurable lead
  time by source height:
  - `prepare.leadTime.upTo1080 = 1h`
  - `prepare.leadTime.above1080 = 36h`

  With no `readyBy`, preparation starts at once. A source above
  `liveMaxHeight` can only be played this way.
- **Who does what:** core decides what to prepare and by when (the lead times
  above, `readyBy`, verification, `prepare.*` events). The engine does the
  transcoding: on an engine with engine-side preparation ([[process/engine-upstream-prs]]), core starts the
  job with `POST /hlsv2/{id}/prepare`, follows its progress and per-segment cache
  status, and verification is exact. This is the reference engine's path, and phase 4
  waits for it ([[process/build-plan]]). Against an engine without it, core could drive the job
  itself, as below; that loop is specified but built only if a stock engine has
  to be supported.
- **How (core-driven, for an engine without the feature):** the normal prepare steps ([[architecture/engine-prepare-stream]]), then request
  every segment in order from the start (on a ladder engine, every rung's
  segments, [[architecture/rendition-and-bandwidth]]), so a partly prepared source is still
  useful. Each response is read and discarded, which moves the whole file across
  the LAN (~4.3 GB per content-hour at 10 Mb/s).
  - Muxed sessions: `seg0…segN`.
  - Multi-audio sessions: every video segment, plus the default audio
    rendition's segments. Other audio renditions are prepared too if
    `prepare.allAudio` is set.
  - Concurrency is the engine's `prepareConcurrency` (home: 1), so live
    sessions keep the GPU and CPU. Output is capped at 1080p, so a prepared 4K
    source takes the same disk space as a 1080p one.
  - Progress is stored in SQLite, so a core restart resumes where it left off.
- **Verification:** at `readyBy − 10 min`, and whenever a token is minted for
  a `full` session, core checks the engine session still exists and is
  complete.
  - If the engine restarted, the session is gone, so the job is re-queued and
    `prepare.lost` is emitted. With `STREMIO_HLS_PERSIST` on (#26), sessions
    survive restarts and this becomes rare.
  - If it can't finish in time (likely for 4K), core emits `prepare.late`. The
    client decides what to do; the client falls back to the best ≤1080p candidate
    unless the host overrides (a watch-party client).
- **Segments that aren't cached.** With #29, a segment ffmpeg produced badly
  (truncated source, or a TS seek that still missed after the retry) is served
  but not cached, so a preparation pass can finish with gaps. Server-go doesn't
  expose whether a segment is cached. On the core-driven fallback, core
  re-requests the whole range once at verification time and compares response
  times: cached segments return in milliseconds. Slow ones are re-queued.
  Engine-side preparation reports cache status per segment, which makes this
  exact ([[process/engine-upstream-prs]]).
- **Status:** `progress.preparedPct` is on the session and in `prepare.progress`
  events.

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
