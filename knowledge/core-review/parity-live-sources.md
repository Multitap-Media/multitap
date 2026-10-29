---
type: Finding
title: "Live sources are ranked playable, but every live session fails"
description: "Streams for tv and channel items are listed as kind live with playable true, while the engine module refuses any source whose probe has no duration, so live TV addons give a list that looks fine and a session that always fails."
tags: [core, review, parity, streams, live]
generated: { by: agent/mcp, at: "2026-10-20T11:55:37Z" }
code_refs:
  - "packages/core/src/selection/candidates.ts"
  - "packages/core/src/selection/rank.ts"
  - "packages/core/src/engines/engine-module.ts"
  - "ROADMAP.md"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** gap (with a misleading listing).
- **Verdict:** confirmed for the listing (PoC test); plausible for the session failure (read from code, no engine run).
- **Where:**
  - `packages/core/src/selection/candidates.ts:129` (`tv`/`channel` URL streams become `kind: 'live'`)
  - `packages/core/src/selection/rank.ts:86` (playable `live` whenever the height fits; live sources aren't treated differently)
  - `packages/core/src/engines/engine-module.ts:462` (no duration and HLS: the session fails with `live`)
  - `ROADMAP.md:331` (Live HLS under Later)

## What happens

Live TV and channel addons (types `tv` and `channel`, usually `.m3u8` URLs) are a standard part of Stremio. Core classifies their streams as `live`, ranks them `playable: true` (`playableWhen: "live"`, which here means "playable now" and has nothing to do with live content), and auto-select may pick one. Creating a session then probes the source; a live playlist has no duration, so `prepare` fails with `live` and the session fails. A client sees a normal source list and a failure only after trying.

## Evidence

`pnpm vitest run packages/core/test/review-poc/parity`: `live TV sources … current: a tv stream is ranked playable` passes (`kind: "live"`, `playable: true` for an `.m3u8` stream of a `tv` item). Session side: `engine-module.ts:462-465` read, not run.

## Fix direction

Until live HLS lands, mark live candidates `playable: false` with an `unplayableReason` such as `live` (an additive enum value) so clients and auto-select skip them; then the ROADMAP's live HLS item.

## Public-release blocker

No, if documented. A public user installing a live TV addon will hit it at once.
