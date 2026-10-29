---
type: Finding
title: Engine sessions can outlive their playback session; nothing reconciles orphaned engine_sessions rows
description: "An engine session whose playback session never recorded its sid (crash or DB error between the engine's master answer and commitReady, an aborted master whose cleanup DELETE fails) or that a concurrent master request recreates during release is never deleted, and on an engine with TTL 0 it stays forever."
tags: [core, review, bugs-playback, engine, retention, leak]
generated: { by: agent/mcp, at: "2026-10-20T13:15:46Z" }
code_refs:
  - "packages/core/src/engines/engine-module.ts"
  - "packages/core/src/sessions/service.ts"
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md); listed in [bugs-playback progress](bugs-playback-progress.md).

- **Severity:** medium. **Kind:** bug (resource leak).
- **Verdict:** confirmed for the crash path; plausible (read) for the others.

## Where

- `packages/core/src/engines/engine-module.ts:473-534`: the master request creates the engine session, then the `engine_sessions` row is written; the playback session learns the `sid` only later, in `commitReady` (`packages/core/src/sessions/service.ts:1047-1098`).
- `packages/core/src/sessions/service.ts:319-337`: `start()` fails sessions left `resolving` as `interrupted`, with no `sid`.
- `packages/core/src/sessions/service.ts:605-624`: release deletes on the engine only through `handleOf(record)`, which needs the record's `sid`.
- `packages/core/src/engines/engine-module.ts:493-500`: an aborted master gets a best-effort `release`; with no row yet, a failed DELETE leaves nothing pending.
- `packages/core/src/engines/engine-module.ts:703-714, 813-843`: release forgets the in-memory state before its DELETE and deletes the row after; a master request through the gateway in between reads the row and recreates the session (self-heal).

## What happens

[engine-retention](../architecture/engine-retention.md) promises that "a release racing a resolution never leaves an engine session behind", and the reference engine runs `STREMIO_HLS_SESSION_TTL=0`, relying on core's deletes. Paths that break it:

1. **Crash mid-prepare.** Core dies after the engine answered the master (row written) and before `commitReady` stored the `sid`. On start the session is failed `interrupted` with `sid` null; retention later releases it with no handle, so no DELETE is sent and the row stays. Nothing ever looks at rows without a live playback session.
2. **`commitReady` throws** (`setChosen` or `update` fail): `#resolve` fails the session `internal-error`; the handle was never stored, same leak.
3. **Release races a master request.** During the release's DELETE (up to the 10 s control timeout), the session is still `ready` in the gateway's cache, and the row still exists, so a player loading the master gets it recreated after the DELETE; then the row is deleted and the playback session marked released. That engine session is orphaned. It needs a viewer (re)loading the master just as the session is released, e.g. when a room ends.
4. **Aborted master, DELETE fails:** no row to keep pending (the code comment says so).

Each orphan keeps its transcode cache on the engine's disk until the engine restarts without persistence.

## Evidence

`packages/core/test/review-poc/bugs-playback/sessions-identity-and-recovery.test.ts`, third test: a ready session is put back in the state a crash leaves (`resolving`, `sid` null, row present), `start()` fails it `interrupted`, a sweep past `RETENTION_IDLE_MS` releases it, and the fake engine has received no DELETE (`expected [] to include 'E000000000000000000001'`); the row is still there.

## Fix direction

On start (and in the sweep), release `engine_sessions` rows whose `session_key` has no open playback session with that `sid`. In release, mark the session released and drop it from the gateway cache before the DELETE, and have `fetchMedia` refuse rows pending release.

## Public-release blocker

No: rare per event, but leaks accumulate on engines that never evict.
