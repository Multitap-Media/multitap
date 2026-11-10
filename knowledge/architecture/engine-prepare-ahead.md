---
type: Component
title: "Preparing ahead: lead times, who does what, verification (phase 4, not built)"
description: "Planned preparation of a full-mode session by its readyBy: lead times by source height, the engine-side versus core-driven paths, the engine's prepare API as merged, verification at readyBy minus 10 minutes, uncached segments, and progress reporting."
tags: [core, engine, prepare, planned, component]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-03T12:00:00Z" }
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
  transcoding: on an engine with engine-side preparation (Rivulet Engine v0.30.0 and later with
  `RIVULET_HLS_PREPARE=1`, upstream #73, [[process/engine-upstream-prs]]), core starts the
  job with `POST /hlsv2/{id}/prepare` (`?audio=default|all`), follows its progress and per-segment cache
  status with `GET`, stops it with `DELETE`, and verification is exact. The engine pins the
  prepared segments outside its per-session cache cap, answers `507` when an explicit
  `RIVULET_HLS_SEGMENT_CACHE_BYTES` can't hold the session, and runs the job at low priority
  (`RIVULET_HLS_PREPARE_CONCURRENCY`, which `prepareConcurrency` mirrors), after live requests and
  after any transcode-ahead (#79). This is the reference
  engine's path, and phase 4 builds on it ([[process/build-plan]], [[process/phase-4-core-checklist]]). Against an engine without it, core could drive the job
  itself, as below; that loop is specified but built only if a stock engine has
  to be supported.
- **The engine's API, as merged** (#73 and #75, read from Rivulet Engine v0.33.2):
  - The session must exist first (the master request). `POST` answers `202`, `GET` `200`, both
    with the status; `DELETE` answers `204`, unpins the segments and keeps the session.
  - Status: `state` (`idle`, `running`, `done`, `failed` with `error`), `audio`, `segments`,
    `total`, `cached`, `uncached`, `failed`, `cachedBytes`, `estimatedBytes`, one `map` string
    per rendition (`playlist`) and `issues`. `GET` works before any job and isn't an access
    to the session.
  - `done` means both passes ran, not that everything is cached: compare `cached` with
    `total`. Failed and uncached segments get one retry after the first pass; three
    transcode errors in a row end the job as `failed`. A `POST` on a finished job starts
    it again and re-checks every segment; on a running job with the same `audio` it
    changes nothing.
  - Errors: `400` invalid id or `audio`, `404` unknown session, `409` the session's
    duration is unknown, `507` as above.
  - Detection: with the feature off the path answers `404`, as for an unknown session.
    `DELETE /hlsv2/{invalid id}/prepare` tells them apart without touching a session:
    `400` with the feature on, the generic `404` without (the same trick as the
    `DELETE /hlsv2/{id}` probe, [[architecture/engine-endpoints-core-uses]]).
  - Lifetime: a session being prepared is never evicted as idle; once the job is `done`
    the idle TTL applies again, so core gives the session a `ttl` (#25) that covers the
    wait, or the engine runs with TTL `0` ([[architecture/engine-retention]]). With
    `RIVULET_HLS_PERSIST` the job resumes after an engine restart; without it, it ends
    with the process.
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
    `prepare.lost` is emitted. With `RIVULET_HLS_PERSIST` on (#26), sessions
    survive restarts, the engine resumes the job itself (#73) and this becomes rare.
  - If it can't finish in time (likely for 4K), core emits `prepare.late`. The
    client decides what to do; the client falls back to the best ≤1080p candidate
    unless the host overrides (a watch-party client).
- **Segments that aren't cached.** With #29, a segment ffmpeg produced badly
  (truncated source, or a TS seek that still missed after the retry) is served
  but not cached, so a preparation pass can finish with gaps. An engine without
  preparation doesn't expose whether a segment is cached. On the core-driven fallback, core
  re-requests the whole range once at verification time and compares response
  times: cached segments return in milliseconds. Slow ones are re-queued.
  Engine-side preparation reports cache status per segment, which makes this
  exact ([[process/engine-upstream-prs]]): one character per segment and rendition
  (`c` cached, `-` not cached, `u` served but not cached, `f` failed), with the reason
  for up to 100 of them.
- **Status:** `progress.preparedPct` is on the session and in `prepare.progress`
  events.

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
