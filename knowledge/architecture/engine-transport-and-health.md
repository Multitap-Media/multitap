---
type: Component
title: "Engine transport, health checks and re-check on an answer"
description: "How core talks to an engine: the lan transport (timeouts, connect timeout, no Origin, no redirects), the future tunnel, health checks with exponential backoff, the immediate re-check when an offline engine answers (2026-10-05), and why core polls."
tags: [core, engine, transport, health, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
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
  carry the URL, which can hold a `mediaURL`. A connect timeout
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
engine whose last check failed fails at once with `engine-offline`; one whose
health isn't known yet is tried.

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

**Polling.** The engine has no push channel, so core polls it: this health check, torrent stats while a session is preparing or ready ([[architecture/engine-prepare-stream]]), and, planned, the preparation status ([[architecture/engine-prepare-ahead]]). The delay in noticing an engine restart is the health interval, or the next segment `404` that self-heal handles ([[architecture/engine-session-lifecycle]]); noticing that an offline engine is back takes the next request it answers (a re-check, above) or the next scheduled check, at most `MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS`. An engine event stream is listed as a possible upstream ask ([[process/upstream-engine-asks]]).

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
