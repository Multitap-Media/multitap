---
type: Process
title: "Checklist for phase 4 in core: prepare jobs on engine-side preparation, then live HLS"
description: "What the reference engine needs before phase 4 starts, the ten pieces of core work in build order (engine client and detection, fake engine, mode full in the engine module, the prepare_jobs table, the scheduler and its events, verification, lifting the 501s, retention and admission, live HLS, documents), what was built on 2026-11-10 and what is still open."
tags: [phase-4, prepare, checklist, core, process]
generated: { by: "agent/claude", at: "2026-11-10T12:00:00Z" }
status: draft
---

The work list for phase 4 of [[process/build-plan]], written on 2026-11-10, when items 6, 7 and 8 of the engine tracking issue were done ([[process/upstream-engine-asks]]). The design is [[architecture/engine-prepare-ahead]]; this concept lists what to build and in what order, and it doesn't replace that design. Items 1 to 8 were built on 2026-11-10 against the fake engine, with the choices recorded in [[decision/prepare-on-engine-side]]; item 9 (live HLS) was built on 2026-11-11 ([[decision/live-hls-sealed-paths]]). It was run against the reference engine on 2026-11-15 and 16, and the fixes that came from it were run there again once merged (below).

**What existed before.** The API already declared the phase 4 shapes: `mode: 'full'`, `readyBy`, the `preparing` status, `progress.preparedPct` and the four `prepare.*` events (`packages/api/src/sessions.ts`, `events.ts`). Core refused them: `POST /v1/sessions` with `mode: 'full'` or a `readyBy`, and `PATCH` with a `readyBy`, answer `501` (`sessions/service.ts`), and the engine module rejects `mode: 'full'` (`engines/engine-module.ts`). The `prepare_jobs` table isn't created ([[architecture/core-persistence]]). Phase 4 is therefore additive on `/v1`: no schema is removed and `api:diff` should show no breaking change.

## Before starting: the reference engine

- Rivulet Engine **v0.31.0 or later** (v0.33.2 is the latest tag on 2026-11-10); v0.30.0 is enough for preparation alone.
- `RIVULET_HLS_PREPARE=1`, with `RIVULET_HLS_PERSIST` so a job resumes after an engine restart, and `RIVULET_HLS_SESSION_OVERRIDES=1` so core can give a prepared session its own `ttl`.
- `RIVULET_HLS_SEGMENT_CACHE_BYTES` unset or negative. An explicit positive value refuses any session whose estimated prepared size is over it (`507`).
- Optional, and independent of phase 4: `RIVULET_HLS_TRANSCODE_AHEAD` and `RIVULET_HLS_RELAY_CACHE_BYTES` ([[process/engine-upstream-prs]]). Measure R10 again with the relay cache on ([[process/risk-register]]).
- The engine's variables are `RIVULET_*` since v0.27.0; `STREMIO_*` names are ignored silently ([[fact/engine-baseline]]).

## The work, in build order

1. **Engine client** (`engines/server-go.ts`). Add the three prepare calls and a `supportsPrepare()` probe, cached and cleared by `resetCapabilities` like the delete probe. The probe is `DELETE /hlsv2/{invalid id}/prepare`: `400` with the feature on, the generic `404` without. Parse the status with a loose schema, so new fields don't break core. Map the errors: `404` is a lost session, `409` an unknown duration, `507` a session that doesn't fit.
2. **The fake engine** (`packages/core/test/fakes/engine.ts`). The prepare routes behind an option that defaults to off, with a status map per rendition, controllable progress, uncached and failed segments, `409` and `507`, and a restart that loses or keeps the job. Core is built and tested against it first, for muxed and multi-audio sessions.
3. **`mode: 'full'` in the engine module.** Run the normal prepare steps ([[architecture/engine-prepare-stream]]) with the height limit at `preparedMaxHeight` instead of `liveMaxHeight`, then start the engine's job. `status()` reports `preparing` and `prepared` with `preparedPct` from `cached` and `total`. A release deletes the engine session, which stops the job. On an engine without the feature, `mode: 'full'` fails with a clear reason; the core-driven loop isn't built (question 1).
4. **The `prepare_jobs` table** and its migration: the session, the state, `start_at`, `ready_by`, the audio selection and the last counts, so a core restart picks its jobs up again.
5. **The scheduler.** Works out each job's start from `readyBy` and the lead time for the source's height, starts jobs that are due, and polls the engine's status. It publishes `prepare.progress` (throttled) and `prepare.done`. The lead times become settings ([[architecture/configuration]] lists them as "not a setting yet").
6. **Verification.** At `readyBy` minus 10 minutes and when a token is minted for a `full` session, read the engine's status. A missing session is re-queued with `prepare.lost`. A job that is `done` with `cached` below `total` is posted again once, since that re-checks every segment; what is still missing is reported. A job that can't finish in time gets `prepare.late`.
7. **Lifting the `501`s.** Accept `mode: 'full'` and `readyBy` on create and on `PATCH`, produce the `preparing` status, and let `highRes: 'prepareOnly'` candidates through ([[concept/source-ranking]]). Check that the idempotency key separates a `play` session from a `full` one of the same source. Follow the `new-route` skill: schema descriptions, `api:generate`, the contract run, the changelog.
8. **Retention and admission.** Retention must not release a session before its `readyBy` ([[architecture/engine-retention]]), and the session's engine `ttl` has to cover the wait after the job is `done`, because the engine's idle TTL applies again then. A session that is only being prepared doesn't count as live load for admission ([[architecture/engine-session-lifecycle]]): the engine runs it at low priority.
9. **Live HLS**, the second half of phase 4 and a separate piece of work: a live handle through the engine's HLS proxy under the same media tokens, with no transcode ([[architecture/media-gateway]]). It shares nothing with items 1 to 8 and can ship in its own release.
10. **Documents.** README (configuration and API), `CHANGELOG.md`, `ROADMAP.md`, and the concepts this changes: [[architecture/engine-prepare-ahead]] (from "not built" to "as built"), [[architecture/playback-session]], [[architecture/engine-module]], [[architecture/core-persistence]], [[architecture/core-events-sse]] and [[process/build-plan]].

## The questions that were open, and what was done

The maintainer said to go with the assumptions (2026-11-10); they are recorded in [[decision/prepare-on-engine-side]].

1. **An engine without preparation:** `mode: 'full'` fails there with `prepare-unsupported`; no core-driven loop.
2. **Failure reasons:** new values, `prepare-unsupported`, `prepare-too-large` and `prepare-failed`.
3. **All audio renditions:** an instance setting, `MULTITAP_PREPARE_ALL_AUDIO`.
4. **The warm-up:** none for `full` sessions; unchanged for `play` sessions ([[architecture/engine-prepare-stream]]).
5. **Order:** prepare jobs first, then live HLS.

## The run against the reference engine (2026-11-15 and 16)

Rivulet Engine v0.31.0 on Windows with QSV and tone mapping, persistence and session overrides on, a proxy password set; core from source; local test sources (1080p and 4K files, a two-audio file, three live channels: plain, behind `proxyHeaders`, AES-128). Every step of the plan passed after three fixes in core; a fourth change came from it.

**Found and fixed in core.**

- **Preparations never started after a normal start.** A scheduler pass over no jobs ended before its promise was stored, so the scheduler stayed marked as running and every later pass returned at once. A start with a stored job hid it. Fixed on 2026-11-16 (`PrepareJobs.tick`), with a warning when a start can't reach the engine and when a pass runs over a minute.
- **Live with `proxyHeaders`** failed with `probe-failed`; the probe now goes through the engine's HLS proxy ([[architecture/engine-prepare-stream]] step 3).
- **Live, AES-128** failed with `probe-failed` because the engine's probe can't read it ([[process/upstream-engine-asks]] ask 14); core reads the playlist instead ([[architecture/media-gateway]]). Such a session is ready only after the engine's probe has timed out, about 30 s.

**Measured.**

- 1080p HEVC, 45 min: prepared in about 15 min, 671 segments, 3.43 GB. The whole prepared session was read back in 16 s.
- 4K HEVC HDR, 27.6 min: 42.9 min of wall time (about 0.64 times real time, with tone mapping), 414 segments, 2.10 GB as 1080p SDR; `preparedPct` rose evenly.
- Two audio tracks with `MULTITAP_PREPARE_ALL_AUDIO`: every rendition prepared and played.
- An engine restart mid-job: the engine resumed the job and core saw no loss. A deleted engine session: `prepare.lost` one poll later, and the job started again.
- `readyBy` with a short lead time: started at `readyBy` minus the lead time; `prepare.late` at `readyBy`.
- Preparation off on the engine: `full` fails with `prepare-unsupported`, `play` is unaffected.
- Live: no URL, host, password or header value in any playlist or in core's log; names from one session answer `404` under another's token; `Range` answers `206`; after a release everything answers `410`.

- **A prepared session was released an hour after its preparation** when nobody played it. A `full` session is now kept for `MULTITAP_PREPARE_SESSION_TTL_MS` ([[architecture/engine-retention]]; maintainer, 2026-11-16).

**Run again on the merged fixes (2026-11-16).** Core at the merge of the fixes, the same engine, 3-minute 1080p sources, a 3 s poll, an idle time of 60 s, a prepare TTL of 10 min and a 10 s sweep. Every step passed.

- **The scheduler:** in a core that started with no engine and no stored jobs and was never restarted, the first `full` session's job started 12 ms after it was queued, and a second one, made after the first was done, in 15 ms. No pass was reported as still running.
- **An engine that is stopped:** the warning that a due job couldn't reach the engine was logged once and then every twentieth try (once a minute at this poll). The job started within one poll of the engine coming back.
- **Retention:** a prepared session nobody touched was still `ready` 182 s after `prepare.done` and was released 602 s after it; its media then answered `410` and the engine had dropped its data. One with a `readyBy` was released 605 s after the `readyBy`. A `play` session and a `full` session that failed its probe were released after 63 s, the idle time.

**Seen, not changed.**

- The WebVTT subtitle rendition isn't prepared by the engine: each subtitle segment of the 4K source took about 13 s on demand.
- The engine's support for preparation isn't shown in `/v1` or at startup; it is probed on the first `full` session.
- A session that fails within milliseconds can fail before a client's event stream is open; a client reads the session after subscribing.
- `delivery: 'direct'` as an explicit value is `501` (not built), not `live`. The status after preparing is `ready` with `progress.phase: 'prepared'`.

## Still open

- Show the engine's preparation support in its capabilities.
- Ask the engine to prepare the subtitle rendition, and to probe AES-128 playlists ([[process/upstream-engine-asks]]).
- Auto-select for a `full` session counts `prepared`-only candidates, but its attempt timeout and attempt count are the ones tuned for live playback.

Related: [[architecture/engine-prepare-ahead]], [[process/build-plan]], [[process/engine-upstream-prs]], [[process/abr-ladder-core-checklist]].
