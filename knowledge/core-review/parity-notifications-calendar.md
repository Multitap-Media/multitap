---
type: Finding
title: "No new-episode notifications or calendar, and no client-side way to build them"
description: "Core has no notifications or calendar for a profile's library series (stremio-core's update_notifications and calendar models), and because the addon catalogs that carry them fail through core, a client cannot build them on top either."
tags: [core, review, parity, library, notifications]
generated: { by: agent/mcp, at: "2026-10-20T11:54:49Z" }
code_refs:
  - "packages/core/src/library/rules.ts"
  - "packages/core/src/http/routes/profiles.ts"
  - "ROADMAP.md"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** gap.
- **Verdict:** confirmed (no route; the client-side path fails, see below).
- **Where:**
  - `packages/core/src/library/rules.ts:75` (`noNotif` stored, always `false`, no route changes it)
  - `packages/core/src/library/rules.ts:387` (continue watching leaves out notification items, by design)
  - `ROADMAP.md:379` (planned under Later)

## What happens

In Stremio, "new episodes" is a basic library feature: stremio-core's `update_notifications.rs` asks every catalog that accepts `lastVideosIds` for the library's series (those passing `LibraryItem::should_pull_notifications`), keeps the new videos per item, folds them into continue watching, and lets the user dismiss them; `calendar.rs` does the same with `calendarVideosIds` for a month view. Cinemeta's manifest declares `behaviorHints.newEpisodeNotifications: true` and both catalogs.

Core has neither: no notifications or calendar route, `noNotif` can't be set, and continue watching never shows a series with a new episode. A client could compute them itself from the library and Cinemeta, except that [those catalogs fail through core](parity-metas-detailed-catalogs.md), and a client of core can't call addons directly (it never sees their URLs). So a player UI on core can't show "new episode" at all.

## Evidence

Route list in `packages/core/src/http/routes/profiles.ts` (no notifications or calendar); the PoC and real run in the linked finding.

## Fix direction

The ROADMAP item (`GET /v1/profiles/{id}/notifications` and `…/calendar` from the `lastVideosIds` / `calendarVideosIds` rule, plus a `noNotif` toggle) after the catalog fix. Fixing only the `metasDetailed` catalog would at least make a client-side version possible.

## Public-release blocker

No. Deliberately deferred and documented; worth stating in the README as a known gap.
