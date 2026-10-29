---
type: Component
title: "Core modules: the planned module tree and how phase 2 named it"
description: "The module tree of core (addons, selection, engine, sessions, library, gateway, segments, api, cli) with the section each module is specified in, and how packages/core/src names them as built in phase 2."
tags: [core, modules, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/"
status: stable
---

Source of truth for core's module layout 

```
addons/
  collection      admin-configured manifest URLs (secrets stay in core)
  manifestCache   fetch + cache manifests; capability index (resources/types/idPrefixes/extra)
  client          GET {base}/{resource}/{type}/{id}[/{extra}].json; per-addon timeout,
                  circuit breaker, honouring cacheMaxAge / staleRevalidate
  aggregate       fan-out catalog/meta/stream/subtitles to matching addons; merge; dedupe
selection/
  parse           release-name + behaviorHints parser → SourceCandidate.parsed
  rank            scoring against the target engine's capabilities (okf:concept/source-ranking)
  autoSelect      optional: candidate choice + fallback loop (okf:decision/auto-select-and-fallback)
engine/
  registry        EngineDescriptors, health checks, capability config
  transport       HTTP over LAN today; tunnel later (okf:architecture/engine-transport-and-health)
  serverGo        typed client for create/stats/probe/master/yt/proxy/metrics
  sessions        engine sessions: prepare / status / release / resolve file (okf:architecture/engine-module)
  prepareJobs     full preparation against readyBy (okf:architecture/engine-prepare-ahead)
sessions/         playback sessions (okf:architecture/playback-session): idempotent create, status, retention (okf:architecture/engine-retention), events
library/          profiles, library items, progress rules, continue watching, next episode (okf:architecture/library-and-profiles)
gateway/          media listener: token check, /media/{token}/… → engine (okf:architecture/media-gateway)
segments/         planned, optional: mounts packages/segments behind MULTITAP_SEGMENTS_PROVIDERS (okf:architecture/segments-module)
api/              /v1 REST + SSE, API keys and scopes (okf:architecture/core-api-keys-security), /v1/admin
cli/              api-key create/list/revoke
```

As built in phase 2, `packages/core/src` names these slightly differently: the
engine code is `engines/` (registry, health, `lan-transport`, `server-go`,
`engine-module`, `resolve` for the matrix); the HTTP layer is `http/` (routes,
CORS, listeners) with `auth/` for keys and scopes; `events/` holds the event
bus, `metrics/` the Prometheus registry, `subtitles/` the converter, and
`cli.ts` the CLI. `prepareJobs` doesn't exist yet (phase 4).

Related: [[architecture/core-v1-api]], [[architecture/core-scope]], [[architecture/engine-module]], [[architecture/media-gateway]], [[concept/addon-aggregation]], [[concept/source-ranking]], [[architecture/segments-module]], [[architecture/boundary-rule]].
