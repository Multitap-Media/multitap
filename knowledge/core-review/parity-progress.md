---
type: Process
title: "Core review: parity progress"
description: "Progress, the parity matrix against stremio-core and the addon SDK, low findings and links to medium+ findings for the parity area of the core adversarial review."
tags: [core, review, parity]
generated: { by: agent/mcp, at: "2026-10-20T11:57:09Z" }
status: draft
---

Area `parity` of the [core adversarial review](charter.md). Started and finished 2026-10-20.

## Status

Done. The full capability matrix is in [the parity matrix](parity-matrix.md). Counts: 0 critical, 0 high, 6 medium, 11 low, 7 info.

**Verdict for the charter's bar:** core does most of the basics stremio-core does for a headless client. The protocol layer (`packages/addon-protocol`) is a faithful port (manifest, extras, routing, URL encoding, responses, meta, streams, subtitles), checked against the Rust source and against real Cinemeta and OpenSubtitles v3. Library rules and the watched bitfield match stremio-core at the reference commit. The gaps are in what core passes on to clients (stream subtitles, external links, live) and what they can read back (per-episode watched, notifications).

## Checked

- `packages/addon-protocol` against `stremio-core/src/types/addon/*`, `types/resource/*`, `addon_transport/http_transport`, `constants.rs` (encode set, extras): line-by-line for `is_resource_supported`, `is_extra_supported`, path building, response keys, stream variant order, meta legacy fields, video sort.
- `stremio-watched-bitfield` crate against `library/watched-bitfield.ts` (`construct_with_videos`, `Display`, `from_str`); library item shape and rules against `types/library/library_item.rs` (incl. the 2026-09-19 "mark watched clears timeOffset" change).
- Models: ctx (profile, addons, notifications), catalog_with_filters, catalogs_with_extra, meta_details, library_with_filters, library_by_type, continue_watching_preview, player, streaming_server, addon_details, installed_addons, local_search, calendar, data_export, link.
- Routes and schemas: `packages/core/src/http/routes/*.ts`, `packages/api/src/{browse,library,selection}.ts`.
- Real run (2026-10-20, scripts in the worker's scratchpad, `@multitap/addon-protocol` client, no core server needed): Cinemeta manifest, catalogs with `genre`+`skip` in both orders, search with `&`, `/` and non-ASCII, series and movie meta, `last-videos` and `calendar-videos`; OpenSubtitles v3 movie and episode subtitles with and without `videoSize`/`filename`. All parse; only the ids catalogs fail (finding 1).
- PoC tests: `packages/core/test/review-poc/parity/parity.test.ts`, run with `pnpm vitest run packages/core/test/review-poc/parity` (6 passed, 4 expected failures).

Not checked: playback through a real engine (bugs-playback's area); YouTube and torrent sources end to end.

## Findings (medium and above)

1. [Catalogs that answer metasDetailed always fail](parity-metas-detailed-catalogs.md): medium, bug, confirmed (PoC and real Cinemeta).
2. [No new-episode notifications or calendar](parity-notifications-calendar.md): medium, gap, confirmed.
3. [A stream's own subtitles are dropped](parity-stream-subtitles-dropped.md): medium, gap, confirmed.
4. [externalUrl streams can never be opened](parity-external-url-hidden.md): medium, gap, confirmed.
5. [Watched episodes only readable by decoding the bitfield](parity-per-video-watched.md): medium, gap, confirmed.
6. [Live sources ranked playable, sessions fail](parity-live-sources.md): medium, gap, confirmed (listing) / plausible (session).

None is a public-release blocker; all are worth a "known gaps" list in the README.

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| L1 | low | gap | `packages/addon-protocol/src/client.ts` `parseTransportUrl` | Legacy transport (`/stremio/v1`) refused; stremio-core still supports it. Rare addons. |
| L2 | low | gap | `packages/core/src/selection/candidates.ts` `UNSUPPORTED` | rar/zip/7z/tgz/tar archive sources, NZB and `playerFrameUrl` listed `unsupported`. Usenet-backed debrid addons are growing; needs engine support. |
| L3 | low | gap | `packages/core/src/addons/aggregate.ts` | No `addon_catalog` resource or route (community addon lists). ROADMAP Later. |
| L4 | low | gap | `packages/core/src/http/routes/browse.ts` | No board/discover aggregate (`catalogs_with_extra` first pages); clients fan out over `/v1/catalogs`. ROADMAP Later. |
| L5 | low | gap | `packages/core/src/http/routes/profiles.ts:277` | Library: no `sort`, no paging; no library change events. ROADMAP Next. |
| L6 | low | gap | `packages/core/src/subtitles/index.ts` | Subtitles in collection order; `subtitlesLanguage` stored but unused for ordering or a default. ROADMAP Next. |
| L7 | low | gap | `packages/api/src/sessions.ts` | No `resumeAt` on session create; client seeks after load. ROADMAP Next. |
| L8 | low | gap | `packages/core/src/addons/meta-view.ts` `metaPreviewView` | Catalog items drop `behaviorHints` (`defaultVideoId`), `links` and trailers that stremio-core's `MetaItemPreview` keeps. |
| L9 | low | gap | `packages/core/src/library/rules.ts:387` | Continue watching leaves out items with new episodes (stremio-core folds them in); follows from finding 2. |
| L10 | low | gap | `packages/core/src/addons/meta-view.ts` | Trailers listed as `ytId` but not playable through a session. ROADMAP idea. |
| L11 | low | gap | `packages/core/src/http/routes/browse.ts:517` | The 500-character cap on any extra value also limits free-text `search`; fine for search, too small for ids extras (finding 1). |
| I1 | info | gap | `packages/addon-protocol/src/stream.ts` | `countryWhitelist` and `notWebReady` parsed and ignored (documented). |
| I2 | info | gap | `packages/api/src/sessions.ts` | No direct play: every source transcodes through the engine (`delivery: 'direct'` answers `501`). ROADMAP Later; the biggest cost difference from Stremio for single viewers. |
| I3 | info | design | `packages/core/src/addons/collection.ts` | `configurationRequired` addons install with status `needs-configuration`; stremio-core refuses the install. Deliberate and documented; a reasonable choice. |
| I4 | info | disputed | `ROADMAP.md:200` | The ROADMAP item "Meta requests go to every matching addon … instead of stopping at the first good answer (stremio-core's behaviour)" misreads stremio-core: `meta_details.rs` also asks all addons (`AggrRequest::AllOfResource`) and shows the first ready one in collection order. Core's final answer already matches; only latency differs (core waits for all). |
| I5 | info | design | `packages/core/src/http/routes/browse.ts:503` | Extras are sent in the catalog's declared order, not the request's; Cinemeta is order-independent (real run), and a fixed order helps addon caches. |
| I6 | info | design | `packages/core/src/addons/meta-view.ts` `embedsAddonUrl` | `stremio:///discover/{transportUrl}/…` genre links are dropped (they carry manifest URLs); `genres` stays, so nothing is lost for a client. |
| I7 | info | gap | engine | YouTube sources play through the engine's `/yt`, capped at 360p (ROADMAP, engine). |
