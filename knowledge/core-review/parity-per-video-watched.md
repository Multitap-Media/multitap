---
type: Finding
title: "Which episodes are watched is only readable by decoding Stremio's bitfield"
description: "There is no route that reads one library item or says which videos of a series are watched; a client must fetch the whole library and port stremio-core's zlib-compressed, anchor-aligned WatchedBitField to tick episodes in a list."
tags: [core, review, parity, library, watched]
generated: { by: agent/mcp, at: "2026-10-20T11:55:25Z" }
code_refs:
  - "packages/core/src/http/routes/profiles.ts"
  - "packages/api/src/library.ts"
  - "packages/core/src/http/routes/browse.ts"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** gap.
- **Verdict:** confirmed (PoC test).
- **Where:**
  - `packages/core/src/http/routes/profiles.ts:277` (`GET …/library`: the whole library, unpaged)
  - `packages/core/src/http/routes/profiles.ts:358` and `:387` (`PUT` and `DELETE` on one item; no `GET`)
  - `packages/api/src/library.ts:216` (`state.watched`: the serialized bitfield as an opaque string)
  - `packages/core/src/http/routes/browse.ts:238` (`GET /v1/meta` takes no profile, so videos carry no watched flag)

## What happens

Every Stremio episode list shows which episodes are watched. stremio-core's `MetaDetails` gives the UI the library item and its `WatchedBitField` for the meta's videos, so the UI asks per video. Core marks episodes and seasons watched faithfully (the bitfield port matches the crate and its test vectors), but reading it back is left to the client:

- there's no `GET /v1/profiles/{id}/library/{type}/{itemId}` (it answers 404/405), so the client fetches the whole library to find one item;
- the only per-episode state is `state.watched`, `{anchorVideoId}:{anchorLength}:{base64(zlib(bits))}`, which is only meaningful against the meta's videos in stremio-core's exact sort order (season, specials last, episode, then date) with the anchor shift applied. A client in a browser needs a zlib inflater and a port of that algorithm to show ticks.

## Evidence

`pnpm vitest run packages/core/test/review-poc/parity`: `current: only the whole library and an opaque zlib bitfield are available` passes (after marking `tt0903747:1:2`, `state.watched` matches `tt0903747:1:2:2:<base64>` and `GET` on the item is 404 or 405); `expected: one item can be read with a watched flag per video` is an expected failure.

## Fix direction

Add `GET …/library/{type}/{itemId}` returning the item plus a decoded `watchedVideos` list (or a per-video map), and/or an optional `profileId` on `GET /v1/meta` that adds `watched` (and progress) to each video. Keep `state.watched` for Stremio compatibility.

## Public-release blocker

No. Writing works and the data is stored; reading is unfriendly enough that most client builders will hit it on day one.
