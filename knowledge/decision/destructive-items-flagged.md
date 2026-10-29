---
type: Decision
title: "Destructive catalog items are flagged, never hidden or auto-picked"
description: "Items and sources whose names match destructive phrases (delete all, wipe, format…) carry a `destructive` flag; they stay listed, never change a score, and auto-select never picks them. Found when a MediaFusion watchlist entry looked like it would empty a debrid account."
tags: [safety, addons, debrid, decision]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/selection/"
status: stable
---

Source of truth for the destructive-item flag (migrated from the former design document, where it sits between the settings table and the storage rules; the `safety` settings group is in [[concept/ranking-settings]]).

**Destructive items** (found 2026-10-06: MediaFusion's debrid watchlist lists
a "delete all files" entry that presumably empties the debrid account when
played). An item whose name matches a `safety.titlePatterns` phrase or whose id
starts with a `safety.idPrefixes` entry carries `flags: ['destructive']` in
catalog, search and meta responses; so does every source listed for it, and a
source whose own name or description matches. Flags never change a score and
nothing is hidden: `GET /v1/streams` lists flagged candidates, and `explain`
names the setting that matched. Auto-select ([[decision/auto-select-and-fallback]]) never picks a flagged
source; a client that picks one by key still gets it played (an explicit
choice), and core logs a warning with the key, never a URL.

Related: [[concept/source-ranking]], [[concept/ranking-settings]], [[decision/auto-select-and-fallback]].
