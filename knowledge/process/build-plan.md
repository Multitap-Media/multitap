---
type: Process
title: "Build history and plan: Multitap's phases"
description: "The phases Multitap was built in (0 spike, 1 addon layer, 2 sessions, gateway and library, the per-item state of phase 3) and the planned ones (4 preparation and live, 5 remote engines), the engine track, direct play and remux, and the optional segments module; phase numbers in code comments refer to this table."
tags: [plan, phases, status, process]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
---

Multitap was built in phases, first inside a larger project whose apps are its first client. Code comments that say "phase 2 step 4" or "phase 4" refer to this table. Releases and their dates are in `CHANGELOG.md` and [[fact/core-release-history]]; what is still open is in `ROADMAP.md`.

| Phase | What it gave Multitap | Status |
|---|---|---|
| **0. Spike** | A script and a small proxy that played a torrent and a debrid URL through one engine session in two browser tabs; measured the engine's segment costs and live limits. The results are folded into the engine concepts ([[architecture/engine-hls-model]], [[process/risk-register]]). | Done 2026-09-28 |
| **1. Addon layer** | The workspace and its boundary lint, `packages/addon-protocol` and `packages/api`, addon collection, client and aggregation ([[concept/addon-aggregation]]), parsing and ranking ([[concept/source-ranking]]), API keys and the CLI, the generated OpenAPI document and the contract run ([[architecture/core-api-testing]]), the `/dev` page. | Done 2026-09-27; fixes 2026-09-30 |
| **2. Sessions, gateway, library** | The engine registry and engine module ([[architecture/engine-module]], [[architecture/engine-session-lifecycle]], [[architecture/engine-transport-and-health]]), playback sessions with auto-select and fallback ([[architecture/playback-session]], [[decision/auto-select-and-fallback]]), media tokens and the gateway on its own listener ([[concept/media-tokens]], [[architecture/media-gateway]]), `/v1/events`, profiles and the library ([[architecture/library-and-profiles]]), retention, CORS, built-in TLS, subtitles, metrics and backups. | Complete 2026-10-06 (0.1.0, 0.1.1) |
| **3. Client additions** | What the first client's watch-party phase needed from Multitap: `GET /v1/whoami` (0.1.2) and per-item player state (0.1.3, [[architecture/core-subtitles-and-player-state]]). | Done |
| **4. Preparation and live** | `readyBy` prepare jobs that drive the engine's preparation, verification and `prepare.*` events; `mode: 'full'`; live HLS (Twitch) through proxy mode ([[architecture/engine-prepare-ahead]]). Needs engine-side preparation (the engine track). | Planned |
| **5. Remote engines** | A helper app, the `tunnel` transport, pairing, capability reporting and local-content affinity ([[architecture/future-remote-engines]]). | Planned |

**Engine track** (in parallel, [[process/engine-upstream-prs]]): before phase 4, engine-side preparation (`POST /hlsv2/{id}/prepare`, a background job, per-segment cache status); after it, the ABR ladder ([[decision/abr-ladder]], [[process/abr-ladder-core-checklist]]).

**Direct play and remux** (later): `player` capabilities and the delivery choice ([[concept/delivery-modes]]), the gateway's byte-range path with direct play first, then a remux output in the engine and Multitap's `remux` delivery.

**Segments** (optional, additive): a module for skip-intro and skip-outro data from third-party providers ([[architecture/segments-module]]).

**Single-user local client** (later, packaging): the engine, Multitap and a one-person UI on one machine, direct play by default.

Related: [[decision/abr-ladder]], [[process/risk-register]].
