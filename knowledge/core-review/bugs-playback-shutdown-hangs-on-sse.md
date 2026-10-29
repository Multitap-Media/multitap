---
type: Finding
title: Graceful shutdown never finishes while an SSE client is connected; held-back progress is lost
description: "With any open GET /v1/events stream (the client always keeps one), RunningCore.close() never resolves, so the 10 s force-exit skips library.flush() and db.destroy() and exits 1, losing up to 90 s of held-back watch progress per playing profile on every restart."
tags: [core, review, bugs-playback, shutdown, sse, data-loss]
generated: { by: agent/mcp, at: "2026-10-20T03:14:03Z" }
code_refs:
  - "packages/core/src/index.ts"
  - "packages/core/src/http/listen.ts"
  - "packages/core/src/http/routes/events.ts"
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md); listed in [bugs-playback progress](bugs-playback-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Status:** fixed 2026-10-20 (see [Fix](#fix)).

## Where

- `packages/core/src/index.ts:240-250`: `close()` awaits `api.close()` before `library.flush()` and `db.destroy()`.
- `packages/core/src/http/listen.ts:67-75`: `server.close()` plus `closeIdleConnections()` only; an active streaming response is never idle, so `close()` waits for it.
- `packages/core/src/http/routes/events.ts:128-160`: the SSE loop runs until the client goes away; nothing ends it on shutdown.
- `packages/core/src/index.ts:290-310`: `shutdown` force-exits with code 1 after 10 s.

## What happens

Core receives SIGTERM (a deploy, `docker stop`, a service restart) while any client holds `GET /v1/events` open. A long-lived client typically keeps one open all the time, so with such a client this is every restart. `api.close()` never resolves, the 10 s timer fires, and the process exits 1 without:

- `library.flush()`: player progress the library holds back under its 90 s push throttle (`PUSH_TO_LIBRARY_EVERY_MS`, `packages/core/src/library/rules.ts:31`) is lost, so continue-watching rewinds by up to 90 s for every profile that was playing;
- `addons.stop()` and `db.destroy()` (SQLite is closed by process exit instead);
- a clean exit code, so supervisors log every planned stop as a failure, and every stop takes the full 10 s.

A long media response (a segment still streaming to a slow player) holds the media listener the same way, but only for the length of that response.

## Evidence

The PoC, now a normal test in `packages/core/test/shutdown.test.ts` (it was `it.fails` in `packages/core/test/review-poc/bugs-playback/shutdown-sse.test.ts`), starts core with `startCore`, opens `/v1/events` with a client key, reads the `: connected` comment, then calls `core.close()`: it hasn't resolved after 3 s (the assertion receives `"timeout"`, not `"closed"`). It resolves only once the SSE client disconnects.

```
pnpm vitest run packages/core/test/shutdown.test.ts
AssertionError: expected 'timeout' to be 'closed'   (before the fix)
```

## Fix direction

On shutdown, end open SSE streams first (a shutdown signal the route's loop watches, or `server.closeAllConnections()` after a short grace period), and flush the library before waiting on listeners.

## Fix

`RunningCore.close()` first aborts a shutdown signal (`AppDeps.shutdown`) that the `/v1/events` loop watches, so every open stream ends and its client reconnects with `Last-Event-ID` later. `Listener.close()` keeps closing connections that turn idle, and cuts any still open after `CLOSE_GRACE_MS` (5 s), which also bounds a long media response. `library.flush()` and `db.destroy()` then run well inside the 10 s force-exit. The design is in [core events](../architecture/core-events-sse.md).

## Public-release blocker

Yes: every operator with a connected event client loses recent watch progress on each restart, and the fix is small.
