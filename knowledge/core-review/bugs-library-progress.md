---
type: Process
title: "Core review: bugs-library progress"
description: "Progress, coverage, low findings and links to medium+ findings for the bugs-library area (addon collection and browse, selection and ranking, library, profiles, persistence and backups) of the core adversarial review."
tags: [core, review, bugs, bugs-library]
generated: { by: agent/mcp, at: "2026-10-20T03:01:48Z" }
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md). Started 2026-10-20.

## Status

Done (2026-10-20). 8 medium findings (all confirmed with `it.fails` PoCs), 15 low and 6 info notes. PoCs: `packages/core/test/review-poc/bugs-library/` (`library-playback`, `selection-*-bugs`, `persistence-*`); run them with `pnpm vitest run packages/core/test/review-poc/bugs-library` (29 expected failures). Selection/ranking and persistence/backups were swept by helper agents; their claims were checked against the code and their PoCs rerun.

## Checked

- `library/watched-bitfield.ts` against `stremio-core/stremio-watched-bitfield` (BitField8, `WatchedField` parse/serialize, `construct_with_videos` offset alignment, `Display` anchor): a faithful port, no divergence found.
- `library/rules.ts` against stremio-core `library_item.rs`, `player.rs` (`TimeChanged`, `Seek`, `item_state_update`, `library_item_state_update`, `MarkVideoAsWatched`), `meta_item.rs` `next_video`, `update_library.rs`, `continue_watching_preview.rs`: the pure rules match (thresholds 0.7 / 0.9, 90 s push, sort keys, `eq_no_mtime`, mark/rewind/remove semantics).
- `library/service.ts` (the player model, throttling, edits while playing, profile settings merge, player state, last source): see the findings below.
- `addons/collection.ts`, `aggregate.ts`, `capabilities.ts`, `index.ts` (`seedDefaults`), `meta-view.ts`, `http/routes/browse.ts` (catalog extras, search targets, meta first-addon rule): routing by resource/type/idPrefixes and catalog paging look right; findings in the low table.
- Selection (`selection/` and `http/routes/ranking.ts`), checked and found correct: multi-episode `S01E01-E03`/`S01E01E02`/`1x05`/`S01.E05` matching, `S01E10` not taken for `S01E01`, years and resolutions not read as episodes, season/multi-season/complete packs, anime absolute numbering treated as unknown; tier ordering with the defaults, seeder cap, uncached penalty; `sortByRank` stability and no NaN scores; language order and request > profile > instance precedence; last-source and binge bonuses; ranking-settings merge/diff/serialized writes and invalid-row fallback; safety case, Unicode boundaries and negatives (`Wipeout`, `Information`); HDR/HDR10+/HLG; CAM/TS detection; proxy headers in keys; stream store TTL and cap.
- Persistence, checked and found correct: WAL, `foreign_keys=ON` and `busy_timeout` on every connection; profile delete cascades to `library_items`, `last_sources`, `item_player_states`; library and last-source queries use their indexes; STRICT tables with 0/1 CHECKs; backups are SQLite online backups (consistent, `integrity_check`, `.partial` then rename, one at a time); restore is manual with core stopped, so no stale in-memory state; a newer-schema backup is refused at startup and an older one migrated; released sessions and expired revocations are purged.
- Real addon check (2026-10-20, Cinemeta, five series incl. The Simpsons and One Piece with 890 and 1242 videos): `metaDetailView` order (specials last), `nextVideo` walking from S1E1 to the last released episode without entering specials, and marking every season watched then reading the bitfield back all behave as stremio-core does. Run with a throwaway vitest file reading the manifest URL from an env var (not kept).

## Findings (medium and above)

- [One player model per profile corrupts watched state when two devices play](bugs-library-one-player-per-profile.md): medium, confirmed.
- [A playback never stopped is never unloaded](bugs-library-no-idle-unload.md): medium, confirmed.
- [Marking the playing episode watched is undone by the next report](bugs-library-mark-playing-watched-undone.md): medium, confirmed.
- [Incremental source lists drop early partials and never signal completion](bugs-library-incremental-partials.md): medium, confirmed.
- [Torrent candidate keys ignore the file choice, so pack episodes share a key](bugs-library-torrent-key-file-choice.md): medium, partly holds after verification; not a release blocker (a pick by key fails safely; only auto-select can race).
- ["DV 5.1" parsed as Dolby Vision profile 5](bugs-library-dv-channel-layout.md): medium, confirmed.
- [Subtitle tags counted as audio languages](bugs-library-subtitle-tags-as-audio.md): medium, confirmed.
- [A migration cut short leaves core unable to start](bugs-library-migrations-not-atomic.md): medium, confirmed; arguably a release blocker (unattended upgrades). Fixed 2026-10-20.

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| L1 | low | bug | `packages/core/src/addons/collection.ts` `#readAll` | A stored manifest that no longer validates (a later, stricter schema; a restored backup) is skipped on load: the addon vanishes from the list, `remove` says `not-found` and `add` of the same URL says `duplicate` (unique `manifest_url`), so only database surgery recovers it. A `manifest_json` that isn't JSON throws out of `#readAll` and fails every addon route. Confirmed: `packages/core/test/review-poc/bugs-library/persistence-addons.test.ts` (both cases). |
| L2 | low | bug | `packages/core/src/addons/index.ts` `seedDefaults` | `DEFAULT_ADDONS` is reinstalled on every start when the collection is empty, so an admin who removes every addon gets the defaults back after a restart; the code comment ("addons the admin removes stay removed") promises otherwise. Plausible (read). |
| L3 | low | bug | `packages/core/src/addons/collection.ts` `reorder`, `remove` | Positions are mutated on the in-memory records before the database transaction; a failed write leaves memory and database disagreeing until restart. Plausible (read). |
| L4 | info | gap | `packages/core/src/library/rules.ts` `itemStateUpdate` | Inherited from stremio-core: with `duration` 0 (unknown), any unload clears the resume offset (`timeOffset > 0 * 0.9`). A client that reports `duration: 0` loses its resume point on `stop`. |
| L5 | info | design | `packages/core/src/library/watched-bitfield.ts:38` | `inflateSync` has no output limit (stremio-core's `read_to_end` neither). The field is only written by core's own rules, so only a crafted backup or database could reach it. |
| L6 | low | bug | `packages/core/src/library/service.ts` `#load`, `report` | The meta is looked up once, when a playback loads. If that lookup fails (addon timeout, open circuit), the whole playback runs without it: crossing 70 % bumps `timesWatched` but never sets the episode in the watched bitfield, there is no next episode on unload, and a new item keeps its id as its name. stremio-core recomputes the bitfield when the meta arrives. Confirmed: `library-playback.test.ts`, "an addon hiccup when playback starts…". Fix: retry the lookup on later reports while `meta` is undefined. |
| L7 | low | bug | `packages/core/src/library/service.ts` `itemFromRow` | `state_json` / `behavior_hints_json` are parsed unguarded: one unreadable row makes the profile's library, continue watching and next answer 500. Confirmed: `persistence-library.test.ts`. |
| L8 | low | bug | `packages/core/src/backup/service.ts` (prune by id timestamp) | After the clock steps back (NTP fix, VM restore), a new backup sorts as oldest and is pruned the moment it is written; the API answers 201 with an id that then 404s. Confirmed: `persistence-backups.test.ts`. Fix: never prune the backup just written. |
| L9 | low | bug | `packages/core/src/backup/service.ts` `toBackup` | A file in `BACKUP_DIR` matching the id pattern with an impossible date throws a RangeError and fails the backup list (500). Plausible (read). |
| L10 | low | bug | `packages/core/src/db/index.ts` | Core and the CLI migrating at once race; one fails part-way. Confirmed, see the [migrations finding](bugs-library-migrations-not-atomic.md). Fixed 2026-10-20 with it. |
| L11 | low | bug | `packages/core/src/selection/safety.ts:26` | Destructive phrases with `.`, `-` or `_` between words (`Delete.All.Files`, `delete_all_torrents`, `Remove-All`) are not flagged. Confirmed: `selection-safety-bugs.test.ts`. Fix: separator `[\s._-]+`. |
| L12 | low | bug | `packages/core/src/selection/match.ts:53-70` | A season pack named without the meta's possessive prefix (`Jack.Ryan.S01` for "Tom Clancy's Jack Ryan") gets the title-mismatch penalty. Confirmed: `selection-match-bugs.test.ts`. |
| L13 | low | bug | `packages/core/src/selection/match.ts:110` | A special (S00E05) against a numbered multi-season pack is judged "another episode". Confirmed: `selection-match-bugs.test.ts`. |
| L14 | low | bug | `packages/core/src/selection/parse/name.ts:78`, `:84`, `extractors.ts:40` | `2020 x264` read as a 360p frame size; portrait `1080x1920` read as 2160p (`too-high` with `highRes` off); `1,234.5 MB` parsed as 234.5 MiB. Confirmed: `selection-parse-bugs.test.ts`. |
| L15 | low | bug | `packages/core/src/selection/ranking-settings.ts:96` | A rejected first load is cached in `#loading`, so every later read and write of ranking settings fails until restart. Plausible (read). |
| L16 | low | gap | `packages/core/src/selection/language.ts:16` | Unmapped 2-letter request codes (`nb`, `ka`, `hy`, `sq`, `mk`, `bs`, …) never match: no language bonus or penalty, silently. Plausible (read). |
| L17 | low | design | `packages/core/src/library/service.ts` `report` | Every load and unload writes at once, so the interleaving in the one-player finding also means one unthrottled write per progress report. |
| I1 | info | design | `packages/core/src/selection/safety.ts` | The `format` pattern flags any source whose description says `Format: …` (blocks auto-select only). |
| I2 | info | design | `packages/core/src/selection/parse/name.ts` | DUAL/MULTi detection tags the film *Dual (2022)* as `mul` (neutral in scoring). |
| I3 | info | gap | `packages/core/src/selection/item-meta.ts` | The `anime` type gets no meta lookup (`RANKED_TYPES` is movie/series). |
| I4 | info | design | `packages/core/src/backup/service.ts` | Restoring an older backup brings back API keys and token revocations as they were; core's restore docs don't say to re-revoke. Backups don't record the core or schema version. Manual backups count toward `BACKUP_KEEP` (documented). |
