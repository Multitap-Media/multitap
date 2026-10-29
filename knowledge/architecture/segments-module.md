---
type: Architecture
title: "Segments: optional skip intro/outro module (planned)"
description: "Planned optional core module for skip-segment data (intro, outro, recap, credits, preview): not an addon, provider interface in packages/segments, GET /v1/segments/{type}/{id}, caching and isolation, the IntroDB and AniSkip providers, timing and the client's part. Decision 2026-10-04."
tags: [core, segments, planned, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
status: draft
---

Source of truth for the planned segments module  Planned, not built.

Decision, 2026-10-04. Skip intro, outro, recap and credits is a **client
feature**: the player owns the playhead, and in a party a skip is a room seek
(the client's job). The segment **data** flows through core, so browsers never
call a third party and there is one User-Agent, one rate limit and one cache.

**Not an addon.** The Stremio addon protocol has no segments resource. An addon
for it would be a custom interface Stremio proper would never adopt, with core
as its only consumer, so it would buy nothing over a module.

**An optional module inside core's process.**
- A workspace package, `packages/segments`: the provider interface, normalised
  types, cache policy and the provider adapters. A dependency-cruiser rule
  stops it importing core internals ([[architecture/overview]]), as with core and the client.
- Core mounts it behind configuration: `MULTITAP_SEGMENTS_PROVIDERS` ([[architecture/configuration]]), empty and
  therefore off by default. When off, the route answers `404`, as an unmounted
  route would, and nothing else changes.
- One additive route, `GET /v1/segments/{type}/{id}` ([[architecture/core-v1-api]]), keyed by item and
  episode the way `videoId` is, not by session, so a client can ask before it
  creates one. It returns normalised `{kind, start, end}` in seconds, with
  `kind` one of `intro`, `outro`, `recap`, `credits` or `preview`, merged from
  the providers, and a per-provider status like the addon outcomes of [[concept/addon-aggregation]]
  (a status and error code each), so a failure is reported, not fatal.
- Caching: a long positive cache and a short negative one (TTL names in [[architecture/configuration]]).
  Requests are deduplicated per key.
- Isolation: per-provider timeout, circuit breaker and metrics, in the style of
  the addon client. A failing or slow provider never affects sessions, sources
  or the rest of `/v1`; the route is off the playback path.

**Why a module with a provider interface.** The first provider is a third-party
hosted service that may fail or be replaced within a year, so the module has to
be optional, removable, isolated and swappable without touching core:
- **IntroDB** (`https://api.introdb.app`): anonymous `GET /intro?imdb=tt…`
  returning start and end seconds; community-contributed. The documentation
  seen showed only a movie-style request. **Episode addressing, outro
  endpoints, and the terms and licence are not stated and must be checked
  before relying on it.**
- **AniSkip**, later: needs a MyAnimeList id, obtainable from a mapping
  metadata addon such as AIOMetadata (core-gap-analysis §4).
- **Embedded chapter markers**, if the engine's probe exposes them (unverified).
- **An addon resource provider**, only if a convention for one ever appears.

**Timing.** Additive, so not needed for the `core-v0.1.0` tag (the end of phase
2, before phase 2.5, [[process/build-plan]]). Planned after the tag as a 0.2.x feature. Designing
the provider interface early avoids a refactor.

**The client's part.** It fetches segments through core's typed client and drives the
skip as a room action. Core knows nothing about rooms.

Related: [[architecture/core-v1-api]], [[architecture/core-modules]], [[architecture/boundary-rule]].
