---
type: Finding
title: "Last-Event-ID from before a core restart can replay as \"complete\" and skip events"
description: "Event ids are a counter that restarts at 1, so once the new run has issued as many events as the client's Last-Event-ID, a reconnect gets X-Events-Replay complete while missing every earlier event of the new run (session.failed interrupted, session.ready)."
tags: [core, review, bugs-playback, sse, events]
generated: { by: agent/mcp, at: "2026-10-20T13:15:45Z" }
code_refs:
  - "packages/core/src/events/memory-bus.ts"
  - "packages/core/src/http/routes/events.ts"
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md); listed in [bugs-playback progress](bugs-playback-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.

## Where

- `packages/core/src/events/memory-bus.ts:77`: ids are `String(counter)`, starting at 1 in every run.
- `packages/core/src/events/memory-bus.ts:106-123`: `replay()` treats an id as "from before a restart" only when it is above the current counter.
- `packages/core/src/http/routes/events.ts:115-122`: the route sets `X-Events-Replay: complete` from that answer.

## What happens

The module comment says a client resuming with an id the bus never issued gets an incomplete replay. That holds only while the new counter is below the old id. A client that saw id 5000, loses its connection over a core restart and reconnects after the new run has published 5000 or more events gets only the events after 5000 of the *new* run, with `complete`. The events it missed (the new run's `session.failed` with `interrupted` for its resolving sessions from `start()`, `session.ready`, `engine.status`) are never sent, and the client has been told not to re-read state, so a room can wait forever on a session that already failed. A busy instance, or an SSE client reconnecting with backoff, reaches that point quickly: every `session.status` progress update and every `streams.partial` takes an id.

The same holds for ids that collide by chance: id N of the old run and id N of the new run are different events.

## Evidence

`packages/core/test/review-poc/bugs-playback/sse-replay-restart.test.ts`: bus A issues ids 1 to 5; a new bus B (the restart) publishes a `session.failed` for `ps_mine` then 7 more events; `B.replay('5', {sessionId: 'ps_mine'})` returns no events and `complete: true`.

```
pnpm vitest run packages/core/test/review-poc/bugs-playback/sse-replay-restart.test.ts
AssertionError: expected false to be true   (with it.fails removed)
```

## Fix direction

Make ids unique across runs: prefix them with a per-start boot id (e.g. `<boot>-<n>`) and treat any id with another boot prefix as `partial`.

## Public-release blocker

No, but it breaks the documented `Last-Event-ID` contract that clients rely on to skip re-reading state.
