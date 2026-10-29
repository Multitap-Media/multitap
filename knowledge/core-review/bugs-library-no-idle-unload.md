---
type: Finding
title: "Review finding: a playback never stopped is never unloaded, so continue watching sticks on a finished episode"
description: "The library service applies stremio-core's unload rules (past 90 % clear the offset and move to the next episode) only on stop, ended, or a report for another video; a client that just goes away (tab closed, app killed, network lost, core restart) leaves the item on the finished episode at 95 %, and next returns that episode instead of the next one."
tags: [core, review, bugs-library, library, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:08:30Z" }
code_refs:
  - "packages/core/src/library/service.ts"
  - "packages/core/src/library/rules.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/library/service.ts:650` (unload only on `stop`/`ended`), `:665` (`flush` on shutdown writes but does not unload), `:720` (`#unload`), `packages/core/src/library/rules.ts:352-362` (`itemStateUpdate`), `:407-425` (`videoToPlay` returns the current video while `timeOffset > 0`).

## What happens

In stremio-core the player is unloaded whenever the app leaves it, so `item_state_update` (offset past 90 % of the duration: clear it and `advance_to_video(next)`) always runs. Core is a remote API: it runs that rule only when a client sends `stop` or `ended`, or reports another video. Nothing unloads an idle playback: there is no idle timeout, and `flush()` on shutdown writes the item as it stands without unloading. Browser tabs closed mid-credits, apps killed, a lost network or a core restart are ordinary, so the item stays persisted at the finished episode with `timeOffset` ≈ 95 %.

Then `GET /v1/profiles/{id}/next/...` returns the same, finished episode (resume at 95 %) instead of the next one, and continue watching shows the old episode. The playback also stays in memory for that profile until its next report.

## Evidence

`packages/core/test/review-poc/bugs-library/library-playback.test.ts`, test "a playback that is never stopped (tab closed) still moves on past the credits" (`it.fails`): progress to 95 % of episode 1, no `stop`, a day passes; with `it` it fails with `expected 'tt0903747:1:1' to be 'tt0903747:1:2'`.

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/library-playback.test.ts
```

## Fix direction

Unload playbacks idle for longer than a few multiples of the push interval (a sweep, or lazily on the next read of that profile's library/next), and unload rather than just write in `flush()`; document that clients should send `stop`, e.g. via `sendBeacon`.

## Public-release blocker

No; it is a visible "continue watching" glitch, not data loss.
