---
type: Finding
title: "Finding: no pagination convention, an unbounded library response, and two list shapes"
description: "The library route returns a profile's whole library (with every last source and player state joined in) on each call with no limit, sort or cursor; admin lists and /v1/catalogs are bare JSON arrays while client lists are envelopes, so the bare ones can't gain paging without a breaking change."
tags: [core, review, design, design-api, api, pagination]
generated: { by: agent/mcp, at: "2026-10-20T11:56:31Z" }
code_refs:
  - "packages/core/src/library/service.ts"
  - "packages/core/src/http/routes/profiles.ts"
  - "packages/api/openapi.json"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw.
- **Verdict:** plausible (read; the size effect was not measured).

## Where

- `packages/core/src/library/service.ts:454-483` (`library()`): selects every `library_items`, `last_sources` and `item_player_states` row of the profile and returns them all; `GET /v1/profiles/{id}/library` (`packages/core/src/http/routes/profiles.ts`) has `type` and `removed` filters only. `continueWatching` reads the same full list, then slices to `CONTINUE_WATCHING_SIZE` (`packages/core/src/library/rules.ts:391-396`).
- `packages/api/openapi.json`: `listAddons`, `reorderAddons`, `refreshAddons`, `listApiKeys`, `listBackups`, `listEngines` and `listCatalogs` answer a bare array; `listProfiles` (`ProfileList`), `getLibrary` (`LibraryItemList`), `listSessionViewers` and the source and subtitle lists answer an object with the array inside.
- Search and catalogs page by the addon protocol's `skip` (the next page is `skip + metas.length`), the only paging in the API.

## What happens

- A Stremio user importing a long-lived library (thousands of items is common) gets the whole thing, joined, on every library read; a client that polls the library (there are no library change events yet, see the roadmap) multiplies it. The cost grows without bound and the client can't ask for less, nor sort server-side (the roadmap's "Library query parameters" lists `sort` and paging as not built).
- Envelope lists can gain `nextCursor`/`total` additively. Bare-array lists can't: any paging there changes the response type, a breaking change by core's own oasdiff rules.
- There is no session list at all (`GET /v1/sessions` is a roadmap item), so a client that loses a session id can only find it through events.

## Evidence

Inventory script over `packages/api/openapi.json` (each operation's `200`/`201` schema: array vs object). Reading of `LibraryService.library()`.

## Fix direction

Pick one list convention now (an envelope `{ items, nextCursor? }` everywhere, or documented "unpaged, small" for the admin lists only), move the bare-array routes to it while 0.x allows breaking changes, and add `limit`/cursor and `sort` to the library.

## Public-release blocker

No for the library (its envelope lets paging come additively), but the bare-array shapes should be settled before outside clients depend on them.
