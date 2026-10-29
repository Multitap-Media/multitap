---
type: Finding
title: "Review finding: one player model per profile corrupts watched state when two devices play"
description: "The library service keeps a single stremio-core player model per profile, so two devices of one profile playing different videos unload and reload each other on every report: the episode actually finished is never marked watched, another is marked by a spurious path, and timesWatched and overallTimeWatched inflate."
tags: [core, review, bugs-library, library, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:08:30Z" }
code_refs:
  - "packages/core/src/library/service.ts"
  - "packages/core/src/library/rules.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** design-flaw (bug in effect).
- **Verdict:** confirmed.
- **Where:** `packages/core/src/library/service.ts:619-628` (`report`: any report for another item or video unloads the profile's one `Playback`), `:93`, `:265` (`#playbacks` is keyed by profile), `packages/core/src/library/rules.ts:352-362` (`itemStateUpdate` on that unload), `:293-338` (`timeChanged`).

## What happens

stremio-core runs one `Player` per app (device). Core models one player per *profile* (`#playbacks: Map<profileId, Playback>`). A profile is the unit of a person, and the product's point is one person's playback across devices (and a household profile on two TVs is ordinary). When two devices of one profile report progress for different videos, every report is an unload of the other's playback plus a load of its own:

- each load's `library_item_state_update` resets the offset (video differs from the stored one) and each `TimeChanged` sees a new `video_id`, so `timeWatched` is zeroed on every report: neither episode crosses the 70 % threshold on its own;
- once one device passes 90 %, every unload of it runs `item_state_update`, which advances `video_id` to the *next* episode; the other device's next report for that episode then lands in the "same video" branch with `timeWatched += time - 1`, crosses the threshold, and increments `timesWatched` again. This repeats on every interleaved report.

Two devices each playing a 45-minute episode (1 and 2) to the end in 30 s steps leave: episode 1 **not** marked in the watched bitfield, episode 2 marked, `timesWatched` = 9, `overallTimeWatched` ≈ 12.9 h. Each report is also an unthrottled database write (load and unload write at once).

## Evidence

`packages/core/test/review-poc/bugs-library/library-playback.test.ts`, test "two devices of one profile playing different episodes both count as watched" (`it.fails`). With `it` it fails with `expected 9 to be less than or equal to 2`.

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/library-playback.test.ts
```

## Fix direction

Key the player model by (profile, device or session) rather than profile, e.g. an optional `deviceId`/`sessionId` in `ProgressReport` with one `Playback` per key and idle expiry; at least make a report for another video of the same item not unload a playback that a different client owns.

## Public-release blocker

No, but should be fixed soon: it silently corrupts watched history for any profile used on two devices at once, the case the product is built around.
