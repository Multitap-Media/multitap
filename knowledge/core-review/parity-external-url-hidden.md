---
type: Finding
title: externalUrl streams are listed but can never be opened
description: "Streams whose only purpose is a link for the user to open (externalUrl and the platform variants) are listed as unplayable with the link withheld, so a client cannot do the one thing the addon protocol defines for them."
tags: [core, review, parity, streams, design]
generated: { by: agent/mcp, at: "2026-10-20T11:55:12Z" }
code_refs:
  - "packages/core/src/selection/candidates.ts"
  - "packages/core/src/selection/rank.ts"
  - "ROADMAP.md"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** gap (a design choice with a parity cost).
- **Verdict:** confirmed (PoC test).
- **Where:**
  - `packages/core/src/selection/candidates.ts:131` (`unplayableReason: 'external'`; the URL is only hashed into `key`)
  - `packages/core/src/selection/rank.ts:77` (external is never playable)
  - `ROADMAP.md:412` (opt-in exposure listed under Ideas / maybe)

## What happens

The SDK defines `externalUrl` as a link the client opens outside the player (a streaming service's page, a store, a web player); stremio-core also has `androidTvUrl`, `tizenUrl`, `webosUrl` and `playerFrameUrl`, and builds `StreamDeepLinks` for them. Official addons such as "where to watch" addons answer only with these.

Core lists such a stream as `kind: "external"`, `playable: false`, `unplayableReason: "external"`, and withholds the URL because raw streams stay in core (okf:architecture/normalized-addon-types). The candidate then is a dead entry: it can't be played through a session and its link can't be shown. The secrets argument is weak for this variant: the link is meant to be shown to the user.

## Evidence

`pnpm vitest run packages/core/test/review-poc/parity`: `current: an externalUrl stream is listed as unplayable with no way to open it` passes (no part of the URL in the list); `expected: the externalUrl is given to the client to open` is an expected failure.

## Fix direction

Expose `externalUrl` (and the platform URLs) on external candidates, off by default behind a setting if secrets in them are a worry, or drop such candidates from the list rather than show what can't be used.

## Public-release blocker

No. Nothing breaks; a class of Stremio addons is useless through core.
