---
type: Component
title: "Core subtitles, timing offset, per-item player state and search extras"
description: "Session subtitle tracks under the media token, the server-side subtitle timing offset (limits, semantics, storage), per-item player state (P1, core 0.1.3), and how search and subtitle extras (videoHash, videoSize, filename) are fanned out."
tags: [core, api, subtitles, player-state, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/subtitles/"
  - "packages/core/src/http/"
  - "packages/core/src/library/"
status: stable
---

Source of truth for core's subtitle, player-state and search behaviour (migrated from the former design document, the bullets between the route table and the events). The routes themselves are in [[architecture/core-v1-api]].

- **Subtitle tracks for a session:** `GET /v1/sessions/{id}/subtitles` lists the
  addon subtitles for the session's item with paths relative to the media base
  (`ext/sub/{fileId}.vtt`), so a player loads them as
  `/media/{token}/ext/sub/{fileId}.vtt` with the same token, including from a
  `<track crossorigin>`. `/v1/subtitles/…` stays for server-side clients.
- **Subtitle timing offset (server-side):** `offsetMs` is signed integer
  milliseconds (positive shows cues later), at most 600000 either way, applied
  by the WebVTT conversion with the semantics of the engine's
  `/subtitles.vtt?offset=` (same unit): a start before 0 becomes 0, and a cue
  that ends at or before 0 is dropped (the engine keeps it as an empty cue).
  `PUT /v1/sessions/{id}/subtitles/{fileId}/offset` stores a session default in
  `session_subtitle_offsets` (survives a restart, deleted with the session; 0
  or `DELETE` clears), so every viewer gets the shift from the gateway without
  setting a player delay, which stays possible per viewer. A media request may add
  `?offsetMs=` (the query is not part of the allowlisted path; `Cache-Control:
  no-store` as ever); the effective offset is the sum, clamped. `/v1/subtitles/file/…`
  takes `?offsetMs=` too. Only the unshifted conversion is cached; the shift is
  applied per request, so varying offsets can't grow the cache. No event is
  emitted on a change (a new event type would break the response union); players
  reload the track, and `GET …/subtitles` reports the current `offsetMs`.
- **Per-item player state (P1, core 0.1.3):** `GET`/`PUT
  /v1/profiles/{id}/items/{type}/{itemId}/state` keep a profile's player
  choices for an item, stremio-core's `StreamItemState`: `audioLanguage`,
  `subtitle` (`{kind: 'embedded', lang, index}`, `{kind: 'addon', lang,
  addonId, fileId?}` or `{kind: 'off'}`; null = no choice), `subtitleOffsetMs`
  and `playbackSpeed`, one row per (profile, item) in `item_player_states`
  like `last_sources` ([[architecture/library-and-profiles]]), deleted with the profile. A `PUT` replaces the
  fields it gives (null clears) and keeps the rest; nothing stored reads as the
  empty state (`updatedAt` null). Library and continue-watching items carry it
  as `playerState` when one is stored. Languages are the durable part (track
  indexes change with the source), so clients match the stored subtitle by
  language, and by `fileId` while that addon still offers the file. Core uses
  it itself: a session created with `profileId` takes `audioLanguage` from it
  when the request names none (so `audioTrack` follows), and starts with
  `subtitleOffsetMs` in `session_subtitle_offsets` for the chosen addon
  `fileId` (an embedded choice, or no `fileId`, seeds nothing). Addon file ids
  are per video, so on the next episode the client sets the offset on the
  track it matched by language.
- **Search and subtitle extras:** `GET /v1/search` fans one query out to every
  enabled catalog that declares the `search` extra (and no other required one,
  as stremio-core's `catalogs_with_extra` does) through the normal aggregation,
  so timeouts, the circuit breaker and the response cache apply; results are
  grouped per catalog with each addon's status, and `skip` pages the catalogs
  that declare it. Addons that use `videoHash`, `videoSize` and `filename` to
  match subtitles (OpenSubtitles) get them: `/v1/subtitles/…` takes them as
  optional query parameters, and `/v1/sessions/{id}/subtitles` finds them
  itself, from the playing stream's `behaviorHints` or else the engine's
  `GET /opensubHash?videoUrl=` (the engine reads the start and end of the
  source). That lookup is lazy (first subtitle list of the session), bounded by
  a timeout, cached per session (a failure for a minute), skipped silently on an
  engine without the endpoint, and never logs the URL.

Related: [[architecture/core-v1-api]], [[architecture/last-source-per-item]], [[architecture/library-and-profiles]], [[architecture/media-gateway]], [[concept/media-tokens]], [[concept/addon-aggregation]].
