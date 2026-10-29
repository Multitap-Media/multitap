---
type: Decision
title: "ABR ladder design (planned, maintainer decisions 2026-10-01)"
description: "Planned engine feature: one decode with many encodes, per-request rungs, hybrid production policy by default, capability-gated as `ladder`, and a codec caveat for mixed viewers. Not built; core is built against a fake engine first."
tags: [abr, ladder, engine, core, decision, planned]
generated: { by: agent/mcp, at: "2026-10-09T15:24:16Z" }
status: stable
---

**Status: planned, not built.** Engine-side status "planned; assumed accepted upstream", not yet filed. Maintainer decisions, 2026-10-01.

Core-side request, identity and gateway effects: [[architecture/abr-ladder-core-api]] ; engine order: Planned engine changes.

Scoping has three concepts: the design and maintainer direction ([[architecture/engine-abr-ladder-design]]), the engine changes ([[architecture/engine-abr-ladder-engine-changes]]), and the open questions, phasing and risks ([[process/engine-abr-ladder-phasing-and-risks]]). Source: the engine ABR ladder scoping write-up (not published).

- **One timeline.** A single ffmpeg run per segment decodes once and encodes every rung. Boundaries and keyframes line up across rungs, so a switch never disturbs party sync (which follows the playhead).
- **Rungs per request.** Core lists them on the create request; each rung is `{ height?, bitrate?, codec? }` with all fields optional. Codec defaults to H.264; HEVC is wanted. All rungs are advertised up front with BANDWIDTH, RESOLUTION and CODECS.
- **Production policies** (engine default, or per request): *lazy* (only when requested), *hybrid* (**recommended default**: active on first request, produced ahead of the leading playhead, dropped after idle), and *all* (every segment gets every rung). Preparation produces every rung in one pass.
- **Capability-gated.** Engine capability `ladder`, detected at runtime. Without it, a ladder request falls back to the top rung with a logged warning.
- **Identity and caps.** The identity includes the effective ladder; `MULTITAP_SESSION_MAX_BITRATE` and `liveMaxHeight` apply per rung.
- **Codec caveat.** A player cannot switch to a rung it cannot decode, so a ladder's codec set must be decodable by every viewer in the room. QSV HEVC encode on the reference engine host and several QSV encoders in one process are untested. AV1 encode is probably unavailable on that iGPU (R30).
- **Cost.** A 1080p/720p/480p ladder is about 1.65× one 1080p encode by pixels.
- **Watch party** (open, decide in phase 3): give each viewer ABR instead of waiting for the slowest.
- **Players** switch at segment boundaries. Lazily made rungs can bias throughput estimates downward (untested with hls.js).

Replaces the single-rendition limit in [[architecture/rendition-and-bandwidth]]. Engine order: [[process/engine-upstream-prs]].
