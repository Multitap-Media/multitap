---
type: Reference
title: "Core review: parity matrix against stremio-core and the addon SDK"
description: "Capability by capability, whether core has, partly has, lacks or deliberately leaves out what stremio-core's models and types and the addon SDK protocol provide, as checked in the 2026-10 review."
tags: [core, review, parity, stremio-core, addon-sdk]
generated: { by: agent/mcp, at: "2026-10-20T11:56:41Z" }
status: draft
---

Part of the [parity review](parity-progress.md). Compared with `stremio-core` at `88be65ba6` (2026-09-24) and `stremio-addon-sdk/docs/api`. Builds on an earlier gap analysis (2026-10-02, updated 2026-10-06; not published), re-checked rather than copied.

**Verdicts:** **have**, **partly**, **missing**, **out** (out of scope on purpose, per `ROADMAP.md` "Deliberately out of scope" and okf:architecture/goals-and-non-goals). **How checked:** C = code read against the Rust source; T = test (existing suite or this review's PoC, `packages/core/test/review-poc/parity`); R = real run against Cinemeta and OpenSubtitles v3 (2026-10-20).

**Bottom line:** core does most of the basics. The addon protocol layer (`packages/addon-protocol`) is a careful, faithful port; browsing, search, meta, sources, addon subtitles, library writes, watched marking, continue watching and next episode all match stremio-core's rules. The gaps a client builder will hit are in what core passes on or reads back: six medium findings, linked below.

## Addon protocol (packages/addon-protocol)

| Capability | Reference | Core | Verdict | How | Note |
|---|---|---|---|---|---|
| Manifest parsing: required `id`, semver `version`, `name`, `types`, `resources`; lenient `logo`/`background` | `types/addon/manifest.rs` | `manifest.ts` | have | C R | Same serde rules (`DefaultOnError`, `UniqueVec`); Cinemeta and OpenSubtitles v3 parse. |
| Catalog extras: full `extra[]` and legacy `extraSupported`/`extraRequired`; canonical `skip` | `ManifestExtra` | `parseManifestExtra` | have | C | |
| `isRequired`, `options`, `optionsLimit` checked on catalog requests | `is_extra_supported`, `ExtraExt::extend_one` | `catalogExtras` (`browse.ts:488`) | have | C T | Stricter than stremio-core (options and length validated); values are sent in the catalog's declared order, not request order (order-independent at Cinemeta, R). |
| Ids extras (`lastVideosIds`, `calendarVideosIds`): one comma-joined value up to `optionsLimit` | `ExtraType::Ids` (`request.rs`) | repeated values only; 500-char cap | partly | R T | [finding](parity-metas-detailed-catalogs.md). |
| Resource routing by `resources`, `types`, `idPrefixes` (short and full forms) | `is_resource_supported` | `isResourceSupported` | have | C R | Line-for-line equivalent, incl. empty prefixes = all ids. |
| Request URL: `/{resource}/{type}/{id}[/{extra}].json`, `URI_COMPONENT_ENCODE_SET`, query string kept | `http_transport.rs` | `request.ts` | have | C R | `&`, `/`, non-ASCII and `:` in ids encode identically; Cinemeta and OpenSubtitles answer. |
| Legacy transport (`/stremio/v1`) | `AddonLegacyTransport` | refused (`unsupported-transport`) | missing | C | Low; legacy addons are rare. |
| Response kinds `metas`, `meta`, `streams`, `subtitles`, `addons`, exactly one key | `response.rs` | `response.ts` | have | C | Invalid list items skipped (`VecSkipError`). |
| `metasDetailed` on catalogs | used by notifications, calendar, live guide | parsed, then rejected by the aggregator | partly | T R | [finding](parity-metas-detailed-catalogs.md). |
| Cache hints `cacheMaxAge`, `staleRevalidate`, `staleError` | SDK | `response-cache.ts` | have | C R | stremio-core itself ignores them; core honours them. |
| Meta items: legacy `trailers`, `released` as string or ms, `posterShape` fallback, videos deduped and sorted (specials last) | `meta_item.rs` | `meta.ts` | have | C R | One invalid video is skipped instead of failing the meta (more lenient). |
| Stream sources: `url`, `ytId`, `infoHash`+`fileIdx`+`sources`/`announce`, `fileMustInclude` | `stream.rs` | `stream.ts`, `engines/resolve.ts` | have | C | Same untagged-enum order. |
| Stream sources: rar/zip/7z/tgz/tar archives, NZB, `playerFrameUrl` | `stream.rs` | parsed, `unsupported` | missing | C | Low; needs engine support. |
| Stream source `externalUrl` (+ `androidTvUrl`, `tizenUrl`, `webosUrl`) | SDK, `StreamDeepLinks` | listed, URL withheld | partly | T | [finding](parity-external-url-hidden.md). |
| Stream `subtitles` | SDK stream object | parsed, never offered | missing | T | [finding](parity-stream-subtitles-dropped.md). |
| `behaviorHints.bingeGroup` | `is_binge_match` | `preferBingeGroup`, binge bonus | have | C | |
| `behaviorHints.proxyHeaders` (request and response) | SDK | engine `/proxy/stream` | have | C | |
| `behaviorHints.filename`, `videoSize`, `videoHash` | SDK | parsing, file choice, subtitle extras | have | C | |
| `behaviorHints.notWebReady` | SDK | ignored | out | C | Everything transcodes; matters with direct play. |
| `behaviorHints.countryWhitelist` | SDK | ignored | missing | C | Low. |
| Subtitles: `id`, `lang`, `url`, `label`; extras `videoHash`, `videoSize`, `filename` in stremio-core's order | `subtitles.rs`, `player.rs` | `subtitles.ts`, `subtitles/index.ts` | have | C R | OpenSubtitles v3 answers with and without extras; SRT/ASS/VTT → WebVTT. |
| Manifest `behaviorHints`: `adult`, `p2p`, `configurable`, `configurationRequired`; `newEpisodeNotifications` | `ManifestBehaviorHints` | exposed on `Addon` | have | C | `configurationRequired` installs as `needs-configuration`; stremio-core refuses to install. Deliberate, documented. |

## stremio-core models

| Model / capability | Core | Verdict | How | Note |
|---|---|---|---|---|
| `ctx` profile, settings | profiles with sparse `settings` in stremio-core names, `client` bag | have | C | |
| `ctx` addon install / uninstall / upgrade, ordering, enable | `/v1/admin/addons…`, refresh, order | have | C | Duplicate rule is the normalized URL (stremio-core: transport URL). |
| `ctx` default / official addons | `DEFAULT_ADDONS` | have | C | Nothing protected. |
| `ctx` Stremio account sync, `PushUserToAPI`, `SyncLibraryWithAPI`, Trakt, ratings, events, link codes | none | out | C | ROADMAP, deliberately out. |
| `ctx` notifications (`update_notifications.rs`), dismiss, `noNotif` toggle | none | missing | C T R | [finding](parity-notifications-calendar.md). |
| `ctx` search history | none | out | C | Client UI. |
| `catalog_with_filters` | `/v1/catalogs` + `/v1/catalog/{addonId}/{type}/{id}` with extras and `skip` | have | C T | Paging ("has next page") is the client's, on `skip`. |
| `catalogs_with_extra` (board / discover first pages) | none | missing | C | Low; client fans out. |
| `catalogs_with_extra` with `search` | `GET /v1/search` | have | C | Skips catalogs with other required extras, as stremio-core. |
| `local_search` (Cinemeta dataset) | none | out | C | |
| `meta_details`: meta from all addons, first ready in collection order | `GET /v1/meta` | have | C | Matches stremio-core (`AggrRequest::AllOfResource`); the ROADMAP item "Meta requests go to every matching addon … instead of stopping at the first good answer (stremio-core's behaviour)" misreads stremio-core, which also asks all. |
| `meta_details`: streams per video, embedded `videos[].streams`, `yt_id:` videos | `/v1/streams`, embedded streams join the list | have | C | |
| `meta_details`: library item and watched bitfield per video | none on meta; whole library only | partly | T | [finding](parity-per-video-watched.md). |
| `meta_details`: trailer streams | listed as `ytId`, not playable via a session | partly | C | Low (ROADMAP idea). |
| `MetaItemPreview` `behaviorHints` (`defaultVideoId`), `links`, trailers on catalog items | dropped from `MetaPreview` | partly | C | Low. |
| `library_with_filters`, `library_by_type`: type, removed, sorts, paging | `type`, `removed`; no sort, no paging, no single-item read | partly | C T | Low (sort, paging); the single-item read is in the watched finding. |
| `LibraryItem` JSON shape (`_id`, `_ctime`, `_mtime`, `state.*` incl. `video_id`, `watched`, `noNotif`) | same names and units, plus `lastSource`, `playerState` | have | C | |
| Library rules: progress, watched threshold 0.7, credits 0.9, temp items, mark watched (clears `timeOffset`, stremio-core 2026-09-19), mark video / season, rewind | `library/rules.ts` | have | C | Up to date with the reference commit. |
| `WatchedBitField` serialization | `watched-bitfield.ts` | have | C T | Crate test vectors in `test/library-rules.test.ts`. |
| `continue_watching_preview` | `GET …/continue` | partly | C | No notification items (follows from the notifications gap). |
| `MetaItem::next_video`, `LibraryItemDeepLinks` | `GET …/next/{type}/{itemId}` | have | C | |
| `player`: progress, seek, pause, stop/ended → library | `POST …/progress` | have | C | |
| `player`: next stream by `bingeGroup` | `source.preferBingeGroup` | have | C | Prefetch timing is the client's. |
| `player`: `StreamItemState` (audio, subtitle, offset, speed) | `…/items/{type}/{itemId}/state` | have | C | |
| `player`: `StreamsBucket` (last stream per item) | `lastSource`, `lastUsed` | have | C | |
| `player`: start at a resume position | no `resumeAt`; client seeks after load | partly | C | Low. |
| `player`: subtitle ordering and auto-select by profile language | collection order | missing | C | Low. |
| `player`: skip intro/outro, seek logs | none | out | C | Segments module planned. |
| `player`: live streams | listed playable, sessions fail | missing | T C | [finding](parity-live-sources.md). |
| `streaming_server`: settings, casting, server URLs | engine registry instead | out | C | Different model on purpose. |
| `streaming_server`: torrent creation, `/opensubHash` | engine module, subtitle hash | have | C | |
| Direct play of web-ready HTTP sources | `delivery: 'direct'` answers `501`; everything transcodes | missing | C | Info; ROADMAP "Later". |
| `addon_details` (preview a manifest) | `POST /v1/admin/addons/preview` | have | C | |
| `installed_addons_with_filters` | `Addon.types`, `resources` | have | C | Client filters. |
| `addon_catalog` resource (community addon lists) | capability index only | missing | C | Low. |
| `calendar` | none | missing | C R | [finding](parity-notifications-calendar.md). |
| `live_tv_guide`, `live_tv_continue_watching` | none | out | C | Revisit with live HLS. |
| `data_export` | backups | out | C | Backups cover it. |
| `link` (account link codes) | none | out | C | |
| Per-profile addon sets | instance-wide | out | C | Deferred, additive. |
