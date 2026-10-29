---
type: Component
title: "Ranking settings: scores are settings, stored overrides, presets and language order"
description: "Every ranking number is an operator setting (tiers, hdr, decodeCost, container, size, language, resolution, release, binge, lastSource, debrid, safety), stored as overrides in core's settings table, changed through /v1/admin/ranking, shareable as presets, with the preferred-language resolution order."
tags: [core, ranking, settings, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/selection/"
  - "packages/api/src/"
status: stable
---

Source of truth for the ranking settings (migrated from the former design document, from "The scores are settings, not code" on). The rules these numbers feed are in [[concept/source-ranking]]. The text on destructive items that sat between the settings table and the storage rules is in [[decision/destructive-items-flagged]].

**The scores are settings, not code** (like the *arrs' Quality Settings, where
the user sets the size range for each quality). The rules above live in code;
every number they use is a ranking setting an operator can change:

| Group | Settings |
|---|---|
| `tiers` | points for debrid-cached, HTTP, healthy torrent and weak torrent; the healthy-seeder threshold; points per seeder |
| `hdr` | penalty without tone mapping; tone-map cost live and prepared; unknown Dolby Vision profile |
| `decodeCost` | per codec and bit depth (H.264 8/10-bit, HEVC 8/10-bit, VP9, AV1, legacy, unknown) |
| `container` | MPEG-TS on a live session; other containers |
| `size` | per resolution, a minimum and maximum in MB per minute of runtime (the *arrs' model); the penalties for too small and too large (live); the floor used when the runtime is unknown |
| `language` | bonus for the first preferred audio language, a smaller one for a later one in the list, penalty when none is present |
| `resolution` | points per resolution up to `liveMaxHeight`, and for an unknown one |
| `release` | penalty per junk release type (CAM, telesync, telecine, screener, workprint); prepared-only penalty; the mismatch penalties (rule 7) |
| `binge` | bonus for the request's `preferBingeGroup` (auto-next, [[decision/auto-select-and-fallback]]): `5000` by default, more than any tier difference, less than the episode mismatch penalty |
| `lastSource` | bonus for the source the request's profile last played for this video ([[architecture/library-and-profiles]]): `4000` by default, more than any tier difference; with the binge bonus (`9000`) still below the episode mismatch penalty |
| `debrid` | `uncachedPenalty`: subtracted from a debrid link marked not cached (rule 2), `2000` by default |
| `safety` | `titlePatterns` (plain phrases, whole words, case-insensitive; defaults `delete all`, `remove all`, `clear all`, `wipe`, `purge all`, `format`) and `idPrefixes` (default none): what flags an item or source `destructive` (below). Not a score |

- **Stored in core's database** (`settings`), over built-in defaults: only the
  values an operator changed are stored, so a later release's better defaults
  still reach everything else.
- **Changed through the admin API** ([[architecture/core-v1-api]]): `GET /v1/admin/ranking` returns the
  effective values and the defaults side by side; `PATCH` changes some, `PUT`
  replaces all, `DELETE` resets to the defaults. Every write is validated
  against the schema in `packages/api`, applies to the next source list
  with no restart, and emits an event. As built: the overrides are one row in
  `settings` (key `ranking`), loaded at startup and cached; an invalid body is a
  `400` and stores nothing; every write emits `settings.changed` with
  `{ key: 'ranking' }`, delivered to admin keys only.
- **Presets for free:** the `GET` body is a complete, shareable ranking preset
  (the way TRaSH Guides shares *arr settings); `PUT` imports one.
- The preferred audio language stays per request, with
  `SELECTION_PREFERRED_LANGUAGE` as the default. Tests check the rules against
  the default values. As built: `preferredLanguage` is a list, most preferred
  first, of three-letter codes (ISO 639-2/B or /T, or 639-3; compared as
  639-2/B), on `GET /v1/streams` (comma-separated) and on `POST /v1/sessions`
  (an array). The resolution order is explicit
  (`selection/language.ts resolvePreferredLanguages`): the request's list,
  else the profile's (`audioLanguage`, `secondaryAudioLanguage`, when the
  request names a `profileId`, [[architecture/library-and-profiles]]), else the instance default. A `PUT`
  preset must now include `language.secondaryMatchBonus` (added after phase
  2's first presets); the later groups (`binge`, `lastSource`, `debrid`,
  `safety`) may be left out of a `PUT` and take the defaults, so older presets
  still import.

Related: [[concept/source-ranking]], [[decision/destructive-items-flagged]], [[decision/auto-select-and-fallback]], [[architecture/core-v1-api]], [[architecture/core-events-sse]], [[architecture/library-and-profiles]], [[architecture/configuration]].
