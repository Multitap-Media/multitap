---
type: Finding
title: "Catalogs that answer metasDetailed always fail (Cinemeta last-videos, calendar-videos)"
description: "Core's catalog route only accepts a metas response, so Cinemeta's new-episode and calendar catalogs (which answer metasDetailed and take one comma-joined list of up to 100 ids) are listed by GET /v1/catalogs but every page fails."
tags: [core, review, parity, addon-protocol, notifications]
generated: { by: agent/mcp, at: "2026-10-20T11:54:36Z" }
code_refs:
  - "packages/core/src/addons/aggregate.ts"
  - "packages/core/src/http/routes/browse.ts"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** bug (Stremio compatibility).
- **Verdict:** confirmed (PoC test and a real run against Cinemeta).
- **Where:**
  - `packages/core/src/addons/aggregate.ts:77` (`extract`: a `catalog` request takes only `response.type === 'metas'`)
  - `packages/core/src/http/routes/browse.ts:517` (`catalogExtras`: each extra value 1 to 500 characters)
  - `packages/core/src/http/routes/browse.ts:542` (`GET /v1/catalogs` lists these catalogs anyway)

## What happens

Cinemeta, the default meta addon, declares two catalogs with a required ids extra: `series/last-videos` (`lastVideosIds`, `optionsLimit` 100) and `series/calendar-videos` (`calendarVideosIds`, `optionsLimit` 100). stremio-core feeds them from the library to build new-episode notifications and the calendar (`AggrRequest::CatalogsFiltered` with `ExtraType::Ids` in `stremio-core/src/types/addon/request.rs`).

Two incompatibilities stop a client from using them through core:

1. **The response kind.** Cinemeta answers these catalogs with `{"metasDetailed": [...]}` (full metas with their videos). `packages/addon-protocol` parses `metasDetailed` correctly, but the aggregator's `extract` for `catalog` returns `undefined` for anything but `metas`, so the addon is reported `status: "error"`, `errorCode: "unexpected-response"`, with no metas. `GET /v1/catalogs` still lists both catalogs as if they worked.
2. **The extra encoding.** stremio-core sends an ids extra as **one** value, the ids joined with `,` (sorted, cut to `optionsLimit`): `lastVideosIds=tt1%2Ctt2`. Sending the name repeatedly (`lastVideosIds=tt1&lastVideosIds=tt2`), which is what core does for `optionsLimit > 1`, makes Cinemeta answer `[null]`. A client can pass the joined form as a single query value, but core caps each value at 500 characters, about 45 ids, where Stremio sends up to 100.

## Evidence

- `pnpm vitest run packages/core/test/review-poc/parity`: `metasDetailed catalogs … current: the catalog is listed but every page fails with unexpected-response` passes; `expected: the page returns the detailed metas` is an expected failure; a 100-id joined value gets `400`.
- Real run (2026-10-20, `@multitap/addon-protocol` client against Cinemeta, script in the worker's scratchpad): repeated `lastVideosIds` → `metasDetailed` with 1 item, `null`, dropped; one joined value `tt0903747,tt0944947` → `metasDetailed`, 2 items with 20 videos each; `calendar-videos` the same with 10 videos each.

## Fix direction

Accept `metasDetailed` for catalog requests (as previews, or a detailed view), and let ids-type extras be passed as a list that core joins with `,` up to `optionsLimit`, with a length limit sized for 100 ids. Or hide catalogs core can't serve from `/v1/catalogs`. See [the notifications gap](parity-notifications-calendar.md), which this blocks.

## Public-release blocker

No. Browsing and playback work; but the default meta addon advertises two catalogs that always fail, and it removes the only client-side path to notifications.
