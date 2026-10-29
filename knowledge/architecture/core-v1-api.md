---
type: Architecture
title: "Core /v1 API: routes, scopes, delivery, error behaviour and versioning"
description: "Core's /v1 API listener: the complete route table (docs:check reads it), bearer API-key scopes, the admin routes built so far, delivery and mediaPath, error behaviour as built, versioning, and using Multitap from your own app."
tags: [core, api, v1, routes, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/http/"
  - "packages/api/openapi.json"
  - "packages/api/src/"
status: stable
---

Source of truth for core's `/v1` API surface  The complete route table below is read by `pnpm run docs:check`: every operation in `packages/api/openapi.json` must appear in it, and a route named here must exist unless marked `planned` or `phase N`.

The section was long, so its topics are split: subtitle tracks, the timing offset, per-item player state and the search and subtitle extras are in [[architecture/core-subtitles-and-player-state]]; the SSE event stream and incremental source lists are in [[architecture/core-events-sse]]. Building and testing the API is [[architecture/core-api-testing]]. (In the original, those topics were bullets between the route table and the versioning rule; their order changed in the split.)

Served on Multitap's API listener (`8080`). It usually stays on a private
network; an operator may expose it, with CORS limited to `MULTITAP_CORS_ORIGINS`.
Authentication is `Authorization: Bearer <apiKey>`. Keys have a scope: `client`,
`admin` or `metrics` ([[architecture/core-api-keys-security]]). Routes are defined with schemas and the OpenAPI document is
generated from them ([[architecture/core-api-testing]]); the listing below is a summary of it.

```
GET    /v1/catalogs                                              CatalogRef[]
GET    /v1/catalog/:addonId/:type/:id?search=&skip=&genre=       MetaPreview[] (flags: ['destructive'] on action-like items, okf:concept/source-ranking)
GET    /v1/search?q=&type=&types=&skip=                          SearchResult: every catalog with a `search` extra, one source per catalog
                                                                 (addon status each; failures reported, not fatal); skip pages catalogs that declare it
GET    /v1/meta/:type/:id                                        MetaDetail
GET    /v1/streams/:type/:videoId?engine=&highRes=&sort=&incremental=&explain=&preferredLanguage=&preferBingeGroup=&profileId=
                                                                 SourceCandidate[]: addon order, or sort=rank (okf:concept/source-ranking);
                                                                 explain=true adds each candidate's score breakdown (okf:concept/source-ranking);
                                                                 flagged candidates (flags, okf:concept/source-ranking) stay listed, never auto-selected;
                                                                 incremental=true → 202 { requestId }, results as streams.partial (okf:concept/addon-aggregation)
GET    /v1/subtitles/:type/:videoId?videoHash=&videoSize=&filename=
                                                                 addon subtitles, served as WebVTT; the optional file hints go to the addons as extras
GET    /v1/subtitles/file/:file?offsetMs=                        one subtitle file as WebVTT, for server-side clients (session tracks use the media token)

POST   /v1/sessions        { key?, item, source: {key} | {auto: true}, engine?, delivery?, mode?, highRes?, quality?, readyBy?, retainUntil?, preferredLanguage?, audioLanguage?, profileId? }
                                                                 → 201 PlaybackSession, status 'resolving'; 200 for an existing one (idempotent by key, okf:architecture/playback-session)
                           delivery: 'auto' (default) | 'direct' | 'remux' | 'transcode' (okf:concept/delivery-modes); `player` (what the client can play) comes with direct play, not built
                           preferredLanguage / audioLanguage: per-request audio language and the start track (okf:architecture/library-and-profiles, okf:architecture/rendition-and-bandwidth)
GET    /v1/sessions/:id                                          PlaybackSession (counts as access, okf:architecture/engine-retention)
PATCH  /v1/sessions/:id    { readyBy?, retainUntil? }            retainUntil: null clears it
POST   /v1/sessions/:id/prepare   { readyBy? }                   switch to mode 'full' (okf:architecture/engine-prepare-ahead) [phase 4; not built]
DELETE /v1/sessions/:id                                          release (okf:architecture/engine-retention) → 204
POST   /v1/sessions/:id/tokens    { subject, ttl? }              → { token, subject, sessionId, mediaPath, mediaUrl?, exp }
DELETE /v1/sessions/:id/tokens/:subject                          revoke one subject
POST   /v1/sessions/:id/tokens/revoke-all                        bump tokenEpoch
GET    /v1/sessions/:id/viewers                                  per-subject telemetry (okf:architecture/media-gateway-proxy)
GET    /v1/sessions/:id/subtitles                                addon subtitle tracks, paths under the media token, with each track's offsetMs
PUT    /v1/sessions/:id/subtitles/:fileId/offset  { offsetMs }   session-wide timing offset for a track (0 clears)
DELETE /v1/sessions/:id/subtitles/:fileId/offset                 clear it
GET    /v1/segments/:type/:id                                    [planned, okf:architecture/segments-module] skip segments for an item or episode (`id` like `videoId`), merged from the configured providers

POST   /v1/profiles        { name }                              → Profile
GET    /v1/profiles                                              Profile[]
GET    /v1/profiles/:id    ·   DELETE /v1/profiles/:id
PATCH  /v1/profiles/:id    { name?, settings? }                  rename, patch settings (okf:architecture/library-and-profiles) → Profile
GET    /v1/profiles/:id/library                                  library items (with lastSource and playerState, okf:architecture/library-and-profiles)
PUT    /v1/profiles/:id/library/:type/:itemId                    add an item to the library (Stremio rules, okf:architecture/library-and-profiles)
DELETE /v1/profiles/:id/library/:type/:itemId                    remove it
POST   /v1/profiles/:id/library/:type/:itemId/rewind             rewind: reset position and watched state
POST   /v1/profiles/:id/library/:type/:itemId/watched            { watched }  mark the item watched or unwatched
POST   /v1/profiles/:id/library/:type/:itemId/videos/:videoId/watched          { watched }  one episode
POST   /v1/profiles/:id/library/:type/:itemId/seasons/:season/watched          { watched }  a whole season
GET    /v1/profiles/:id/continue                                 continue watching
GET    /v1/profiles/:id/next/:type/:id                           next episode to play
GET    /v1/profiles/:id/items/:type/:itemId/state                per-item player state (P1, below): audioLanguage, subtitle, subtitleOffsetMs, playbackSpeed
PUT    /v1/profiles/:id/items/:type/:itemId/state  { audioLanguage?, subtitle?, subtitleOffsetMs?, playbackSpeed? }   fields given replace (null clears), the rest kept
POST   /v1/profiles/:id/progress  { item, videoId?, time, duration, event?, name?, poster? }   core applies the rules (okf:architecture/library-and-profiles)
                           event: 'progress' (default) | 'seek' | 'pause' | 'stop' | 'ended'

GET    /v1/events?session=&request=&types=                       SSE (below)

GET    /v1/admin/ranking                                         effective ranking settings + defaults (okf:concept/source-ranking)
PATCH  /v1/admin/ranking   { …partial }   ·   PUT (all)   ·   DELETE (reset to defaults); includes the safety patterns
POST   /v1/admin/backups                                         back up the database now -> 201 { id, createdAt, sizeBytes, kind }; 409 if one runs (okf:architecture/core-persistence)
GET    /v1/admin/backups                                         the backups, newest first
GET    /v1/admin/backups/:id   ·   DELETE /v1/admin/backups/:id  download the SQLite file (a secret) · delete
/v1/admin/*        addons, engines, API keys; later sessions and prepare jobs   [admin scope]
GET    /metrics                                                  Prometheus text   [metrics or admin scope]
GET    /v1/whoami                                                the calling key: { id, scope, label, createdAt, lastUsed }   [client or admin scope]
GET    /openapi.json                                             the generated document   [client scope]
GET    /healthz                                                  liveness + database   [no key]
```

The admin routes built so far: `/v1/admin/addons` (list, add, reorder,
refresh, patch, delete, and `POST /preview`: fetch and validate a manifest URL
by the install rules and return the `Addon` view without storing it, with an
empty `id` unless that URL is installed; the URL is never logged or returned), `/v1/admin/engines` (list, get, `PUT`, delete),
`/v1/admin/api-keys` (list, create, revoke), `/v1/admin/ranking` and
`/v1/admin/backups` (create, list, download, delete). An admin
view of sessions and prepare jobs isn't built yet.

- **Delivery** ([[concept/delivery-modes]]): the session's `delivery` says how its media is served.
  With `auto` core picks from the `player` capabilities, and without them it
  transcodes. Until direct play and remux are built, asking for them returns
  `501`.
- `mediaPath` is `/media/{token}/master.m3u8` for a transcode session, and
  `/media/{token}/stream` for direct play or remux. With `MULTITAP_MEDIA_PUBLIC_BASE` set
  (required whenever the media listener is public) the response also carries
  the absolute `mediaUrl`, which is what cross-origin players use.
- **As built in phase 1:** `/openapi.json` needs a `client` key (no landing page);
  a documented path called with the wrong method gets `405` with `Allow`; addon
  subtitles are served from `/v1/subtitles/file/{id}.vtt`, so original subtitle
  URLs stay in core. That route needs an API key, so browsers get subtitles
  through the media listener instead (phase 2, above).
- **As built in phase 2:** a route whose body is required answers `400`
  without a JSON `Content-Type` (Hono would otherwise read the body as `{}`,
  which an all-optional `PATCH` schema accepts). For `405`, the most specific
  documented path wins: `/v1/sessions/{id}/tokens/revoke-all` is not
  `…/tokens/{subject}`, so `revoke-all` can't be used as a subject. Session
  create answers `409` for an expired or unknown candidate key, `422` for a key
  from another item's source list, `400` for an unknown engine, and `501` for
  what isn't built (`mode: 'full'`, `readyBy`, `direct`, `remux`); a released
  session answers `410` to `PATCH`, minting and its subtitle list. A cross-origin
  `/v1` caller may also send `Last-Event-ID`, so a fetch-based SSE client can
  resume.
- **Versioning:** the path carries the major version. `/v1` changes are
  additive by default (a new route, an optional request field, a new response
  field) and ship in a patch release. `pnpm run ci` runs `api:diff`, which
  fails on any change oasdiff rates as breaking against the latest `core-v*`
  tag, a new response-enum value included ([[architecture/core-api-testing]]).
  While core is 0.x a breaking `/v1` change is allowed only on purpose:
  accepted in `packages/api/breaking-accepted.txt`, shipped in a minor
  release, and listed under "Breaking changes" in the changelog, so a client
  that pins a minor version gets none. From 1.0, `/v1` takes no breaking
  changes; they go to `/v2`. The user-facing text is the changelog's
  "Versioning rules" ([[process/core-release]]).

**Using Multitap from your own app.** Run the engine and Multitap, create a `client`
key with the CLI, and either put a small backend (or a desktop app) in front
that holds the key, or, for a personal single-user app, call `/v1` straight from
the browser with its origin in `MULTITAP_CORS_ORIGINS`. It browses through `/v1`, shows
the source list the way any Stremio app does, creates a session for the source
the user picks, mints one token, and plays `mediaUrl`. No reverse proxy is
needed: core can serve TLS itself. Ranking and auto-select are there if it wants
them, and it gets the same preparation, retention and library behaviour as
any other client.

Related: [[decision/contract-first-api]], [[architecture/playback-session]], [[concept/media-tokens]], [[concept/delivery-modes]], [[architecture/library-and-profiles]], [[concept/source-ranking]], [[architecture/media-gateway]], Adding or changing a /v1 route in core.
