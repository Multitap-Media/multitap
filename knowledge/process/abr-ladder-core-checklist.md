---
type: Process
title: Checklist for the core side of the ABR ladder
description: "The seven places the phase 2 build assumes one rendition per session (gateway filename allowlist, viewer telemetry, master self-heal and stored overrides, session identity, admission load, the fake engine, API schemas), found by review on 2026-10-01; none is a defect today, each needs extending and a test."
tags: [abr, ladder, checklist, core, process]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:38:03Z" }
status: stable
---

Source of truth for this topic (migrated from the former design document, "Checklist for the core side of the ABR ladder"). Part of the engine-track row of [[process/build-plan]]; design in [[decision/abr-ladder]] and [[architecture/abr-ladder-core-api]].

These are the places the phase 2 build assumes one rendition per session, found by reviewing it on 2026-10-01. None is a defect today; each needs extending, and each gets a test:

1. **Gateway filename allowlist** ([[architecture/media-gateway]]). It admits only the file names the engine uses now (`master.m3u8`, media playlists, `segN.ts`, `a0segN.ts`). Add the rung playlist and segment names, with allowlist tests for the new cases.
2. **Viewer telemetry.** `lastSegment` is parsed from the file name. Teach the parser the rung names, or telemetry reports the wrong segment.
3. **Master self-heal and stored overrides.** Core re-sends a session's applied overrides on every master request, from memory or from `engine_sessions`. Store and re-send the rung list the same way, so a recovered session is still a ladder.
4. **Session identity.** The engine session id and the idempotency key include the effective quality; add the effective ladder, so two ladders never share a session.
5. **Engine load for admission control** ([[architecture/engine-session-lifecycle]]). Load counts sessions that fetched a segment recently; count active rungs instead on a ladder engine.
6. **The fake engine.** A ladder implementation behind the `ladder` capability, so core is built and tested against it first; keep the one-rendition behaviour for the engine without it.
7. **API schemas.** A ladder form of `quality` on the create request and on `PlaybackSession`, additive, so `api:diff` shows no breaking change.

Also reword the remaining "one rendition per session" comments in the engine module and gateway.

Related: [[architecture/engine-abr-ladder-design]], [[process/engine-abr-ladder-phasing-and-risks]], [[architecture/rendition-and-bandwidth]].
