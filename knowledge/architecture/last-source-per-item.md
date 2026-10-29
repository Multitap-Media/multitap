---
type: Component
title: "Last source per (profile, item)"
description: "When a session created with profileId becomes ready, core records the source in last_sources, one row per (profile, item); source lists flag it lastUsed and auto-select ranks it up."
tags: [core, library, last-source, selection]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/library/"
  - "packages/core/src/sessions/"
status: stable
---

Source of truth (migrated from the former design document, "Last source per item"; as built, gap analysis item 9; stremio-core's `StreamsBucket`).

When a session created with `profileId` becomes ready, core records the source for that profile and item: a `sourceIdentity`, the video, the addon, the stream's labels and its `bingeGroup`. The identity is the candidate key itself, a hash of the addon id, the source fields and the `proxyHeaders` ([[architecture/normalized-addon-types]], [[architecture/normalized-addon-types]]): any later list gives the same stream the same key, so it needs no expiry of its own and is not a secret (the raw stream stays in the session's secret column).

It's stored as **one row per (profile, item)** in `last_sources`, not per video and not on the library item: resuming only needs the latest source, another episode's stream never has the same key anyway (and its `bingeGroup` carries the release over, [[decision/auto-select-and-fallback]]), the table stays as small as the library, and stremio-core's `LibraryItem` shape stays untouched (a session may be ready before the item has any progress).

The library and continue-watching lists show it as `lastSource` (core's addition to the item). A source list for the profile flags the matching candidate `lastUsed: true` and auto-select ranks it up (`lastSource`, [[concept/source-ranking]]; [[concept/source-ranking]]). If the addons no longer offer it, nothing matches and the normal ranking applies.

Related: [[architecture/library-and-profiles]], [[architecture/playback-session]].
