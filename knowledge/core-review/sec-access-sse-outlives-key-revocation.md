---
type: Finding
title: "Finding: an open /v1/events stream keeps delivering after its API key is revoked"
description: "The API key is checked only when GET /v1/events opens; revoking the key leaves an already open SSE stream (heartbeats keep it alive) delivering every event, admin-only ones included, until the client disconnects or core restarts."
tags: [core, review, security, sec-access, api-keys, sse]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-20T03:12:12Z" }
code_refs:
  - "packages/core/src/http/routes/events.ts"
  - "packages/core/src/auth/middleware.ts"
  - "packages/core/src/auth/keys.ts"
status: draft
---

Area: [sec-access](sec-access-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** security.
- **Verdict:** confirmed (PoC test).
- **Status:** fixed 2026-10-25 (see [Fix](#fix)).

## Where

- `packages/core/src/auth/middleware.ts:25-38`: `requireScope` verifies the key once per request.
- `packages/core/src/http/routes/events.ts:92-163`: the SSE loop runs until the client goes away, writing a heartbeat every `EVENTS_HEARTBEAT_MS` (15 s); nothing re-checks the key or reacts to its revocation.
- `packages/core/src/auth/keys.ts:104-117`: `revokeApiKey` only stamps `revoked_at`; nothing is notified.

## What happens

A key leaks (a client log, a laptop) and the operator revokes it with `core api-key revoke` or `DELETE /v1/admin/api-keys/{id}`. Every new request with it now gets `404`, but a `GET /v1/events` stream the attacker opened beforehand stays open indefinitely (the heartbeats stop idle timeouts) and keeps delivering every event the key could see at connect time: session lifecycle with session ids, `streams.partial` source lists, and for an `admin` key the admin-only `settings.changed` and `engine.status`. It ends only when the client disconnects or core restarts. Read-only, and events carry no media tokens or secrets, so the impact is continued disclosure of what is being watched; but "a revoked key stops working" is the property operators rely on after a leak, and nothing tells them it doesn't hold here.

The same applies in principle to any long-running request (an incremental source-list stream), but `/v1/events` is the one with no natural end.

## Evidence

`packages/core/test/review-poc/sec-access/access.test.ts`, test "BUG sec-access-sse-outlives-key-revocation" (`it.fails`): opens `/v1/events?types=settings.changed` with an admin key, revokes the key (`/v1/whoami` then answers `404`), publishes `settings.changed`, and the open stream delivers it.

```
pnpm vitest run packages/core/test/review-poc/sec-access
# with it.fails switched to it, the assertion fails as expected:
AssertionError: expected ': connected\n\nevent: settings.change…' not to contain 'settings.changed'
```

## Fix direction

Have revocation reach open streams: e.g. the SSE loop re-verifies its key (by id, cheaply) on each heartbeat and closes when it is revoked, or `revokeApiKey` publishes an internal signal the events route subscribes to and ends that key's streams.

## Fix

The `/v1/events` loop re-checks its key by id (`apiKeyActive` in `auth/keys.ts`, one primary-key lookup) each time it wakes for an event or a heartbeat, before writing anything. A revoked key's stream ends at once, with an `info` log line (`event stream ended: api key revoked`, naming the key id), and the client's reconnect gets the unknown-route `404`. Because the check reads the database, it also catches `core api-key revoke` run from the CLI in another process; an idle stream ends within one `EVENTS_HEARTBEAT_MS`. The route's OpenAPI description says so, and the design is in [core events](../architecture/core-events-sse.md).

Tests: the PoC is now two normal tests in `packages/core/test/events.test.ts` (revoked through `DELETE /v1/admin/api-keys/{id}` while an admin-only event is published; revoked in the database only, as the CLI does, on an idle stream). Both fail with the check removed.

Not covered, as before: other long-running requests (an incremental source list) finish on their own, and revoking a key still doesn't revoke the media tokens it minted (sec-access L4, now stated in `SECURITY.md`).

## Public-release blocker

No, but cheap to fix before release: needs a leaked key, and only discloses events, but it silently breaks the revocation guarantee.
