---
type: Finding
title: "Review finding: marking the episode that is playing as watched is undone by the next progress report"
description: "MarkVideoAsWatched advances the loaded item's video_id at once, unlike stremio-core's player which defers the advance to unload; the next progress report for the playing episode resets video_id and the watched flag, so continue watching returns to the episode and it can be counted watched twice."
tags: [core, review, bugs-library, library, finding, parity]
generated: { by: agent/mcp, at: "2026-10-20T13:08:30Z" }
code_refs:
  - "packages/core/src/library/service.ts"
  - "packages/core/src/library/rules.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug (stremio-core semantics core claims to follow).
- **Verdict:** confirmed.
- **Where:** `packages/core/src/library/service.ts:566` (`markVideoWatched` through `#edit`, which edits the loaded playback in place, `:733`), `packages/core/src/library/rules.ts:471-484` (`markVideoWatched` calls `advanceToVideo` at once), `:303-309` (`timeChanged` resets `video_id`, `timeWatched` and `flaggedWatched` when the reported video differs).

## What happens

stremio-core has two variants. `MetaDetails::MarkVideoAsWatched` (no player) advances at once. The player's `ActionPlayer::MarkVideoAsWatched` deliberately does *not*: it sets `marked_video_as_watched` and leaves the advance to `item_state_update` on unload, with the comment that otherwise `TimeChanged` would reset it back to the playing video (`stremio-core/src/models/player.rs`, around line 833).

Core has only the first variant but applies it to the playing item too (the `#edit` comment says this is so the next progress write doesn't undo the edit). It does: the next report for the playing episode finds `video_id` = the next episode, so `timeChanged` sets it back, zeroes `timeWatched` and `flaggedWatched`, and moves `timeOffset` to the reported time. On `stop` the unload has no "marked watched" flag, so unless the position is past 90 % nothing advances. Result: continue watching and `next` point at the episode the user marked watched, at the stop position; and if playback continues past 70 % of the episode it is counted in `timesWatched` a second time. The same applies to `markSeasonWatched` (`reconcileSeriesResumeAfterWatchedChange`).

## Evidence

`packages/core/test/review-poc/bugs-library/library-playback.test.ts`, test "marking the playing episode watched survives the next progress report" (`it.fails`): play to 20 min of 45, mark it watched, report 20.5 min, stop at 21 min; with `it` it fails with `expected 'tt0903747:1:1' to be 'tt0903747:1:2'`.

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/library-playback.test.ts
```

## Fix direction

When the edited item is the loaded playback and the video is the one playing, port the player variant: set the bitfield, keep `video_id`, and record a `markedVideoAsWatched` / `markedSeasonAsWatched` flag on the `Playback` that `#unload` passes to `itemStateUpdate`.

## Public-release blocker

No; a stremio-parity glitch in continue watching.
