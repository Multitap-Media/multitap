---
type: Process
title: "Checklist for phase 4 in core: prepare jobs on engine-side preparation, then live HLS"
description: "What the reference engine needs before phase 4 starts, the ten pieces of core work in build order (engine client and detection, fake engine, mode full in the engine module, the prepare_jobs table, the scheduler and its events, verification, lifting the 501s, retention and admission, live HLS, documents), what was built on 2026-11-10 and what is still open."
tags: [phase-4, prepare, checklist, core, process]
generated: { by: "agent/claude", at: "2026-11-10T12:00:00Z" }
status: draft
---

The work list for phase 4 of [[process/build-plan]], written on 2026-11-10, when items 6, 7 and 8 of the engine tracking issue were done ([[process/upstream-engine-asks]]). The design is [[architecture/engine-prepare-ahead]]; this concept lists what to build and in what order, and it doesn't replace that design. Items 1 to 8 were built on 2026-11-10 against the fake engine, with the choices recorded in [[decision/prepare-on-engine-side]]; item 9 (live HLS) is open, and so is a run against the reference engine.

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
5. **Order:** prepare jobs first; live HLS is next.

## Still open

- Run it against the reference engine (v0.31.0 or later, set up as above), with a real 4K source and an engine restart mid-job.
- Live HLS (item 9).
- Auto-select for a `full` session counts `prepared`-only candidates, but its attempt timeout and attempt count are the ones tuned for live playback.

Related: [[architecture/engine-prepare-ahead]], [[process/build-plan]], [[process/engine-upstream-prs]], [[process/abr-ladder-core-checklist]].
