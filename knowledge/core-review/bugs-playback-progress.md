---
type: Process
title: "Core review: bugs-playback progress"
description: "Progress, coverage, low findings and links to medium+ findings for the bugs-playback area (sessions, engine module, gateway streaming lifecycle, events and SSE) of the core adversarial review."
tags: [core, review, bugs, bugs-playback]
generated: { by: agent/mcp, at: "2026-10-20T13:16:22Z" }
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md). Started 2026-10-20, finished 2026-10-20.

## Status

Done. 5 medium findings (4 confirmed by PoC, 1 confirmed for its main path), 0 high, 0 critical; 10 low or info. PoC tests: `packages/core/test/review-poc/bugs-playback/` (all `it.fails`, so the suite stays green; `pnpm vitest run packages/core/test/review-poc/bugs-playback` → 6 expected fails). Not validated against a real engine: the medium findings are core-side logic, reproduced with `startCore`, the session rig and the fake engine.

## Checked

- **Sessions** (`sessions/service.ts`, `identity.ts`, `repository.ts`, `sqlite-repository.ts`): create and idempotency (identity fields, the per-identity lock), picked and auto-select resolution, attempt timeout and late-success release, torrent retry, `engine-busy` and `engine-offline` handling, `commitReady`/`commitFailed` under the per-id lock, release aborting a resolution, retention sweep and pending-release retries, start-up recovery of `resolving` sessions, the gateway seam (`mediaTarget` cache, `touch`), admission. Repository writes are column patches, so `touch` and status updates don't lose each other's fields.
- **Engine module** (`engine-module.ts`, `resolve.ts`, `registry.ts`, `health.ts`, `lan-transport.ts`, `server-go.ts` client calls): engine session lookup or mint, in-flight sharing, abort handling on each step, the row insert and pending-release cancel, warm-up, stats refresh, release and `retryReleases`, self-heal master in `fetchMedia`, health loop, re-check on answer, address change, transport timeouts and aborts.
- **Gateway** (`gateway/app.ts`, `viewers.ts`, token state in `tokens.ts`): check order, retry once on segment 502/504/404, pass-through and backpressure (`highWaterMark: 0`, pull-based), detach on viewer disconnect, `HEAD`, error mapping.
- **Events** (`events/memory-bus.ts`, `http/routes/events.ts`): ids, replay and `complete`, subscribe-before-replay with dedupe, heartbeat and wake-up race, unsubscribe on abort, shutdown.
- **Design concepts checked against code:** playback-session, engine-module, engine-session-lifecycle, engine-retention, engine-prepare-stream, engine-transport-and-health, media-gateway, core-events-sse, decision/auto-select-and-fallback. Mismatches are in the findings (identity; "a release racing a resolution never leaves an engine session behind"; `Last-Event-ID` replay after a restart).

## Findings (medium and above)

| Finding | Severity | Verdict | Blocker |
|---|---|---|---|
| [Shutdown hangs on an SSE client; held-back progress lost](bugs-playback-shutdown-hangs-on-sse.md) | medium | confirmed; fixed 2026-10-20 | yes |
| [Last-Event-ID after a restart replays as complete and skips events](bugs-playback-sse-replay-after-restart.md) | medium | confirmed | no |
| [Unbounded detached segment transcodes, HEAD included](bugs-playback-detached-segment-amplification.md) | medium | confirmed | no |
| [Idempotency ignores the engine and highRes](bugs-playback-identity-ignores-engine-highres.md) | medium | confirmed | no |
| [Orphaned engine sessions are never reconciled](bugs-playback-orphaned-engine-sessions.md) | medium | confirmed (crash path) | no |

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| L1 | low | bug | `engines/lan-transport.ts` (request), `server-go.ts` `readJson`, `gateway/app.ts` `drain` | Engine timeouts cover only the time to response headers. An engine that sends headers and then stalls (a torrent losing peers mid-segment) leaves a detached segment drain, a `torrentStats` refresh (`statsRefreshing` stays true, so stats never refresh again) or a picked source's probe/master body read waiting with no limit; a stuck picked session is only cleared by retention after `RETENTION_IDLE_MS`. Plausible. |
| L2 | low | bug | `sessions/service.ts` `#admit` | Admission is checked before the new job is registered, under the per-identity lock only, so concurrent creates with different keys (or none) all pass `ENGINE_ADMISSION=reject` at the limit. Soft limit by design; plausible. |
| L3 | low | design-flaw | `http/routes/events.ts` (`pending`) | Each SSE subscriber's queue is unbounded: a client that stops reading (TCP backpressure stalls `writeSSE`) makes core buffer every matching event, `streams.partial` candidate lists included. Key holders only; plausible. Related to [sec-input unbounded memory](sec-input-unbounded-memory.md). |
| L4 | low | design-flaw | `http/routes/events.ts` | `?session=` without `Last-Event-ID` replays nothing, unlike `?request=`: a client that subscribes after `POST /v1/sessions` misses a fast `session.ready`/`failed` unless it also reads the session. The design says "or poll", so documented, but easy to get wrong; replaying the session's buffered events would close it. |
| L5 | low | design-flaw | `packages/api/src/sessions.ts` (`retainUntil`), `sessions/service.ts` `update` | `retainUntil` has no upper bound and no operator cap: one request pins a session, and its engine disk, for years. |
| L6 | low | bug | `gateway/tokens.ts:75` (`#sessions`) | The token service's per-session state is never dropped when a released session is purged: one entry per session for the process lifetime, and a purged session's media answers `410` instead of the documented `404`. |
| L7 | low | bug | `sessions/identity.ts` | A picked source's identity leaves out `profileId`: a second profile reusing the key gets the first profile's session, its last source isn't recorded and its subtitle offset isn't applied. (Noted in the identity finding.) |
| L8 | info | design-flaw | `sessions/service.ts` `create` | An idempotent create ignores the second request's `retainUntil` (and `audioLanguage`, documented); a client re-creating to extend retention must `PATCH`. |
| L9 | info | bug | `engines/engine-module.ts` `#prepare` (`failed`) | The failure log's `torrentStats` call has no signal, so an aborted or timed-out torrent attempt can take up to the control timeout (10 s) longer to settle. |
| L10 | info | design-flaw | `engines/registry.ts` `get` | Every gateway request does two SQLite reads (engine descriptor and proxy password) via `registry.get` before the engine call. Fine at today's scale. |

## Not findings (checked and fine)

- Release racing a resolution: aborted job plus `commitReady` under the per-id lock releases a late-ready engine session (except the paths in the orphan finding).
- Auto-select attempt timeout: the late success is released; the in-flight share can't hand a retry the aborted run, since aborts settle long before the retry wait ends.
- SSE: subscribe-before-replay plus id dedupe loses nothing within one run; `wake` can't be missed (no await between draining and arming); abort unsubscribes.
- Gateway pass-through honours backpressure (pull-based, `highWaterMark: 0`); playlists and subtitles cancel upstream on disconnect.
