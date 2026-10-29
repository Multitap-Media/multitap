---
type: Component
title: "Core profiles, Stremio-format library and last source"
description: "Profiles own settings and library items in Stremio's library format; core applies stremio-core's progress and watched rules; last source per (profile, item) lives in its own concept; the client maps every account but admins to a profile."
tags: [core, profiles, library, history, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/library/"
  - "packages/api/src/library.ts"
status: stable
---

Source of truth for core profiles and the library  The client-side mapping in the last section is still sourced from Watch history and Continuity across devices until those migrate.

## Profiles

```ts
Profile { id: string, name: string, createdAt: string, settings: ProfileSettings }
```

- A profile owns library items. It's the unit a Stremio user account would be.
- **Settings** (as built, gap analysis item 2): stremio-core's per-profile `Settings`, in its camelCase field names and defaults, for the fields a headless client has a use for: the audio and subtitle languages, subtitle style (size, font, bold, offset, colours, opacity, ASS styling), `bingeWatching`, the seek steps, `nextVideoNotificationDuration`, `interfaceLanguage`, `playInBackground`, `hardwareDecoding`, `hideSpoilers`. Unknown keys in that typed subset are rejected. Fields of the official apps alone (`streamingServerUrl`, `escExitFullscreen`, …) and a client's own go in `client`, an opaque JSON bag of at most 16 KiB that core never reads. `PATCH /v1/profiles/{id}` renames (the create rules: stored as given, 1–100 characters, not only whitespace) and patches settings: a typed field given replaces its value, `client` keys merge (a null value removes one). Only what a client set is stored (`profiles.settings_json`), merged over the defaults on read, so a later release's defaults reach the rest. One deviation: `audioLanguage` defaults to null (stremio-core: `eng`), meaning "the instance's `SELECTION_PREFERRED_LANGUAGE`", so a profile nobody configured doesn't override the operator's default.
- **What core does with them:** a source list (`GET /v1/streams?profileId=`) or session (`POST /v1/sessions` with `profileId`) for a profile ranks with its `audioLanguage` and `secondaryAudioLanguage` when the request names no `preferredLanguage` (request > profile > instance, [[concept/source-ranking]]), and the session's `audioTrack` follows them. `bingeWatching` is only stored: when to play the next episode stays the client's call ([[decision/auto-select-and-fallback]]). The subtitle languages are for clients choosing a track; core doesn't order subtitles by them yet.
- It has no credentials. Clients map their own users to profiles; the client maps each host account to one (Watch history).
- The addon collection belongs to the core instance for now. Per-profile addon collections are a possible later addition. A household where each person brings their own debrid account (one profile each, each person on their own devices) makes them a stronger later candidate; they stay deferred and additive.

## Library and history

- **Per profile.** Each profile has library items in Stremio's library item shape, taken from stremio-core's types: `_id`, `type`, `name`, `poster`, `state.timeOffset`, `state.duration`, `state.lastWatched`, `state.timesWatched`, `state.flaggedWatched`, `state.video_id`, and the per-series watched-episodes bitfield.
- **Core applies the rules.** Clients report positions (`POST /v1/profiles/{id}/progress`). Core follows stremio-core for what to persist: how often progress is saved, the "watched" threshold near the credits, and next-episode choice.
- **Reads:** library, continue watching, and the next episode for an item ([[architecture/core-v1-api]]).
- **Why that format:** "continue watching" and auto-next behave like Stremio. Optional sync of a profile to a Stremio account (via Stremio's datastore API) can be added later without migrating data.
- A session isn't tied to a profile's library. The client decides whose library a playback counts toward, and can report to several profiles. A session may name one profile (`profileId`) for selection: its languages, and its last source ([[architecture/last-source-per-item]]).

## Client use and per-item state

A client maps its people to profiles as it likes; a watch-party client, for example, gives each account that keeps history one profile, made when first needed. Per-item player state (0.1.3, 2026-10-09): a per-profile, per-item bag (audio language, subtitle, subtitle offset, speed) modelled on stremio-core's `StreamItemState`; core seeds a new session's audio language and subtitle offset from it (Per-item player choices live in core as a StreamItemState-like bag).

Related: [[decision/stremio-core-reference-not-base]], [[architecture/boundary-rule]], [[architecture/core-scope]].
