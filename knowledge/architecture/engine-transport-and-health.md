---
type: Component
title: "Engine transport, health checks and re-check on an answer"
description: "How core talks to an engine: the lan transport (timeouts, connect timeout, no Origin, no redirects), the future tunnel, health checks with exponential backoff, the immediate re-check when an offline engine answers (2026-10-05), checks on demand from the engine module (2026-11-04), and why core polls."
tags: [core, engine, transport, health, component]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T02:45:00Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth for engine transport, health checks and re-check on an answer  Interface and overview: [[architecture/engine-module]].

```ts
interface EngineTransport { request(path: string, init?: RequestInit): Promise<Response> }
```

- **`lan`** (today): plain HTTP to the descriptor's `address`
  (`http://winbox.lan:11470`). As built: http(s) only and no credentials in the
  address; a timeout per call, up to the response headers (control `10s`,
  prepare `150s`, media `200s`, [[architecture/configuration]]); never an `Origin` header (server-go
  refuses disallowed origins, [[architecture/engine-security-posture]]); redirects aren't followed; errors never
  carry the URL, which can hold a `mediaURL`. The caller's signal aborts the
  body too, until the body ends (read, cancelled or failed), when the
  transport stops listening to it. A connect timeout
  (`MULTITAP_ENGINE_CONNECT_TIMEOUT_MS`, default `3s`, TCP and TLS) sits under the
  per-call ones: a stopped engine host's firewall drops connections to the
  closed port silently, and undici's default 10 s connect timeout made every
  request wait that long (a reference-engine restart test, 2026-10-05; hls.js gives
  up on a segment at 10 s anyway). A connect timeout fails like a refused
  connection (`engine-offline`). Node's bundled undici doesn't export its
  `Agent`, so core depends on the `undici` package at the version Node bundles
  for the dispatcher; requests still use the global `fetch`.
- **`tunnel`** (future, [[architecture/future-remote-engines]]): requests are multiplexed over an outbound
  connection the engine's helper opened to core. Until it's built, a `tunnel`
  descriptor fails every request as unreachable.

Nothing above the transport cares which one is in use.

**Health checks** (as built): core requests `GET /metrics` from every engine
every `MULTITAP_ENGINE_HEALTH_INTERVAL_MS` while it answers, backing off exponentially to
`MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS` (default `60s`; it was `5m`) while it doesn't. A
success sets `online` and
`lastSeen` (stored in `engines.last_seen`); each change of `online` publishes
`engine.status`, and coming back online forgets the engine's detected features
(it may have been upgraded). A prepare on an
engine whose last check failed asks for a check on demand (below) and fails
with `engine-offline` only when that fails too; one whose health isn't known
yet is tried.

**Re-check on an answer** (as built, 2026-10-05). In a reference-engine restart test
the engine came back while core still saw it offline: segment requests through
the gateway succeeded, but new sessions failed with `engine-offline` until the
next scheduled check (about 10 s there; with the old `5m` backoff cap it could
have been minutes). Now any `2xx` an engine gives a request (a segment, a
playlist, a control call) while core has it offline resets its backoff and
triggers a health check at once. The answer only triggers the check; the
`/metrics` probe stays the one thing that sets `online`, so `last_seen`, the
`engine.status` event, the capability reset and the metrics keep one path, and
a single answer (possibly to a request sent before the engine went away) isn't
taken as proof. These re-checks run one at a time and at most once per 5 s per
engine; answers in between are coalesced into one re-check at the end of the
gap. Only `2xx` counts: a `5xx` may come from something in front of the
engine.

**Checks on demand** (as built, 2026-11-04). The engine module asks the
health monitor for a check (through the registry) in two cases: before it
refuses a prepare on an engine marked offline, and after a request to the
engine got no answer (timed out, reset, refused). The check runs at once
unless a re-check ran within the 5 s gap above (then its result counts), and
a check already running is joined. Without it, an engine that restarted was
refused until its scheduled check (up to `MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS`),
and one slow or reset request ended a whole auto-select as `engine-offline`
although the engine was fine. Now a request with no answer is `engine-offline`
only when the check fails too; otherwise that source failed (`engine-error`,
[[architecture/engine-prepare-stream]]). Without a monitor (tests), the last
known state counts, and unknown is taken as offline. A release on an engine
marked offline sends nothing and is pending at once ([[architecture/engine-retention]]).

**Polling.** The engine has no push channel, so core polls it: this health check, torrent stats while a session is preparing or ready ([[architecture/engine-prepare-stream]]), and, planned, the preparation status ([[architecture/engine-prepare-ahead]]). The delay in noticing an engine restart is the health interval, or the next segment `404` that self-heal handles ([[architecture/engine-session-lifecycle]]); noticing that an offline engine is back takes the next request it answers (a re-check, above), the next prepare on it (a check on demand), or the next scheduled check, at most `MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS`. An engine event stream is listed as a possible upstream ask ([[process/upstream-engine-asks]]).

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
