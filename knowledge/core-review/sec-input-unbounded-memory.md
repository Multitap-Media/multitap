---
type: Finding
title: "Addon-sized data is cached by count, not bytes"
description: "The addon response cache (1000 entries) and the events replay buffer (1000 events) are bounded by count only, while each addon response may be 8 MiB, so a hostile addon can grow core's heap to gigabytes."
tags: [core, review, security, sec-input, memory, dos]
generated: { by: agent/mcp, at: "2026-10-20T03:13:38Z" }
code_refs:
  - "packages/core/src/addons/response-cache.ts"
  - "packages/core/src/events/memory-bus.ts"
  - "packages/core/src/config.ts"
status: draft
---

Part of the [sec-input review](sec-input-progress.md).

- **Severity:** medium. **Kind:** security.
- **Verdict:** plausible (read from code; not measured).
- **Where:** `packages/core/src/addons/response-cache.ts:37-66` (count-bounded LRU), `packages/core/src/config.ts:471` (`ADDON_RESPONSE_CACHE_ENTRIES` default 1000), `packages/addon-protocol/src/client.ts:27` (8 MiB per response), `packages/core/src/events/memory-bus.ts:79-80` and `packages/core/src/config.ts:509` (`EVENTS_REPLAY_SIZE` 1000, by count; `streams.partial` events carry addon stream data).

## What happens

An addon sets `cacheMaxAge` (core clamps it to 7 days) and answers each distinct request (every search term, `skip` page, item id) with close to 8 MiB of valid JSON. Each is parsed into objects several times larger than the text and kept. 1000 entries can reach several GiB of heap, past Node's default old-space limit, and core crashes or thrashes. No field length is bounded either (names, descriptions, `behaviorHints`, unknown keys kept by `looseObject`), so the same data flows on to clients and into the replay buffer. The subtitle VTT cache, by contrast, is bounded by bytes (`SUBTITLE_VTT_MAX_BYTES`), which is the right model.

## Evidence

Code reading only. A PoC would install a fake addon returning 8 MiB catalogs with `cacheMaxAge` and request 1000 distinct `skip` values while watching `process.memoryUsage().heapUsed`.

## Fix direction

Weigh cache entries by response byte size with a total cap (like the subtitle VTT cache), lower the per-resource size caps (catalogs and streams rarely need 8 MiB), and truncate long string fields at parse time.

## Public-release blocker

No, but it should be fixed soon after: it needs a hostile addon and some browsing, and a restart recovers.
