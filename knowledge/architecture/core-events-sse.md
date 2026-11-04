---
type: Component
title: "Core events: SSE stream, replay and incremental source lists"
description: "GET /v1/events server-sent events: event types, filters, heartbeat, the bounded replay buffer with Last-Event-ID and the X-Events-Replay header, and incremental source lists answered with 202 and streams.partial events."
tags: [core, api, events, sse, component]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T12:00:00Z" }
code_refs:
  - "packages/core/src/events/"
  - "packages/core/src/http/routes/events.ts"
  - "packages/api/src/"
status: stable
---

Source of truth for core's event stream (migrated from the former design document, the events and incremental-list bullets). The routes are in [[architecture/core-v1-api]].

- **Events** (`GET /v1/events`, server-sent events): `session.status`,
  `session.ready`, `session.failed`, `session.released`, `prepare.progress`,
  `prepare.done`, `prepare.lost`, `prepare.late`, `streams.partial`, and for
  admin keys only `settings.changed` and `engine.status`. Each message carries
  `id`, `event` (the type) and `data` (the whole event, the `MultitapEvent` schema);
  a `: heartbeat` comment keeps idle connections open (`MULTITAP_EVENTS_HEARTBEAT_MS`).
  Filters: `session` (one playback session), `request` (one incremental source
  list) and `types` (comma-separated; an unknown type is a `400`).
  A bounded replay buffer (`MULTITAP_EVENTS_REPLAY_SIZE`) serves `Last-Event-ID` on
  reconnect, and the `X-Events-Replay` response header says `complete` or
  `partial`; after `partial`, clients re-read session state. The buffer is a
  ring (a publish costs the same when it's full), and a replay starts at the
  slot after `Last-Event-ID`, since buffered ids are consecutive. Each event
  is serialised once, however many streams send it. A browser reads the
  header through CORS ([[architecture/core-deployment]]).
- **A slow reader** has its events queued on its stream; once more than
  `EVENTS_PENDING_LIMIT` (10 000) wait beyond its replay, the stream ends
  (an `info` line, `event stream ended: the reader fell too far behind`) and
  the client reconnects with `Last-Event-ID`, getting what the buffer still
  holds (`partial` when that's not everything). Memory per stream stays bounded.
- **Shutdown** ends every open stream: `RunningCore.close()` aborts a shutdown
  signal (`AppDeps.shutdown`) that the route's loop watches, so the response
  finishes and the API listener can close. The route adds one listener to that
  signal and fans out to the open streams, so any number of streams stays
  under Node's `MaxListeners` warning. Clients see the stream end and
  reconnect with `Last-Event-ID` once core is back. Listeners cut any response
  still open after `CLOSE_GRACE_MS` (5 s), well inside `main`'s 8 s
  force-exit ([[architecture/core-deployment]]), so held-back library progress is always flushed
  ([[architecture/library-and-profiles]]).
- **Key revocation** ends a stream too. The key is checked when the stream
  opens, and the loop re-checks it by id (`apiKeyActiveCached`) each time it
  wakes for an event or a heartbeat, before writing anything. A revoked key's
  stream ends there, with an `info` line naming the key id, and the
  client's reconnect gets the unknown-route `404`. The check reads the
  database at most once a second per key, one query shared by all the key's
  streams and wake-ups; a revocation through `revokeApiKey` in this process
  (`DELETE /v1/admin/api-keys/{id}`) updates that answer at once. Reading the
  database rather than only an in-process signal also catches
  `multitap api-key revoke` run from the CLI in another process: an idle
  stream ends within a heartbeat plus about a second
  ([[architecture/core-api-keys-security]]).
- **Incremental source lists** (as built in phase 2): `GET /v1/streams/…?incremental=true`
  answers `202` at once with a `requestId`, and each addon's candidates follow
  as a `streams.partial` event, in answer order, the last one with
  `remaining: 0`. Subscribing with `?request={requestId}` and no
  `Last-Event-ID` first replays every buffered event of that list, so a client
  that subscribes after the `202` misses nothing.

Related: [[architecture/core-v1-api]], [[architecture/core-api-keys-security]], [[architecture/playback-session]], [[concept/addon-aggregation]], [[concept/ranking-settings]], [[architecture/core-api-testing]].
