---
type: Component
title: "Source list, ranking and playability rules"
description: "How core annotates each addon candidate for the target engine: the standard source list, explain breakdowns, the playability rules and the numbered scoring rules (tiers, HDR, decode cost, container, size, mismatches, resolution)."
tags: [core, ranking, addons, selection, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/selection/"
status: stable
---

Source of truth for the source list and the ranking rules (migrated from the former design document; the rule numbers 1–8 are cited as such). The ranking settings, presets and language resolution are in [[concept/ranking-settings]]; the destructive flag is [[decision/destructive-items-flagged]].

**The source list is the standard behaviour.** `GET /v1/streams` returns every
candidate the addons gave, like a normal Stremio client: grouped in addon order,
each addon's streams in the order it returned them. Each candidate is annotated
for the target engine (`parsed`, `playable`, `playableWhen`, `score`), so a UI
can grey out what won't play and badge what needs preparing. `sort=rank` returns
the same list ordered by `score` instead. Nothing is hidden in either order.

**`explain=true`** (default `false`, also on `streams.partial` events) adds an
`explain` object to each candidate: `contributions`, the ordered rules that moved
the score, each `{rule, points, detail?}` with a stable rule id (`tier`,
`uncached`, `hdr`, `decodeCost`, `container`, `size`, `language`, `languageSecondary`, `binge`,
`lastSource`, `resolution`, `preparedOnly`, `release`, `titleMismatch`, `episodeMismatch`, …)
and signed points; `weights`, the ranking settings behind those rules, by name
(`tiers.http`); and `playability`, the rule 1 verdict (`playable`,
`unplayableReason`, `playableWhen`); and, for a flagged candidate, `flags`, the
safety settings that matched (below). It is computed by the ranking code itself:
the score is the sum of the registered contributions, so their points add up to
`score` exactly, and a new rule is one more registered contribution. `detail`
holds parsed values only, never raw stream fields, URLs or headers. Without the
flag the response is unchanged.

Candidates are scored **for a specific engine**, using its capabilities ([[concept/engine-descriptor]])
and the request's `highRes` policy:

1. **Not playable here** (`playable: false` with an `unplayableReason`; kept in
   the list, never auto-selected):
   - `externalUrl` (`external`).
   - DV profile 5 (`dv5`). #27's tone mapping deliberately skips it, because
     the colours can't be recovered without a Dolby Vision decoder.
   - Candidates that require a different engine (`other-engine`).
   - Above `liveMaxHeight` when `highRes` is `off` (`too-high`). When it's
     `prepareOnly` or `on`, the candidate is playable with
     `playableWhen: 'prepared'`: a session for it needs `mode: 'full'` or a
     `readyBy`. `on` exists for future engines where `liveMaxHeight` is
     higher; the engine limit still wins.
2. Debrid-cached > HTTP > healthy torrent (seeders) > weak torrent. A debrid
   link the addon marks as **not cached** (`parsed.cached: false`: Torrentio's
   `[RD download]`, an hourglass `⏳` in the label as MediaFusion uses) is tiered
   as HTTP and loses `debrid.uncachedPenalty` (rule `uncached`, default
   `2000`): it plays only after the debrid service fetches it, so it ranks
   below healthy cached and torrent sources but isn't excluded, and auto-select
   still reaches it when nothing better plays. Markers core doesn't know leave
   `cached` unset (found in the 2026-10-06 MediaFusion test, where uncached
   sources ranked as plain HTTP).
3. **SDR preferred.** HDR10/HDR10+/HLG are penalized heavily on an engine whose
   `tonemap` is false, because they'd look washed out. With tone mapping on (the
   reference engine runs #27), the penalty only reflects its CPU cost: small for
   prepared sessions, larger for live ones on the reference engine host (Reference engine hardware and measured performance). Dolby Vision with
   no stated profile gets an extra penalty, since release names rarely say, DV
   profile 5 is common in 4K web releases, and a wrong guess gives a broken
   picture (phase 0). Its default (`hdr.dvUnknownProfilePenalty`, `1000`, raised
   from phase 1's `200`) is the size of a tier, so such a release ranks well
   below the same release with a stated profile 8 or without Dolby Vision.
4. Decode cost on this engine (software decode today): 8-bit H.264 > 8-bit
   HEVC > 10-bit HEVC > AV1.
5. **Container:** MPEG-TS (`.ts`, `.m2ts`) gets a small penalty for live
   sessions. Long keyframe intervals make seeks land late (Pre-roll cost per segment, and timestamps verified fine); #29 repairs
   this with a second ffmpeg run per affected segment. That doesn't matter when
   prepared. Otherwise prefer MKV/MP4 at equal quality.
6. Size sanity for the runtime, and language preference.
7. **Mismatches score very low, but stay listed** (an addon may be wrong, or a
   person may want it anyway). For an episode request: a season or complete
   pack containing the episode is fine (the addon points at the right file); a
   different episode of the same show gets a heavy penalty, below every matching
   playable candidate; a different title gets the heaviest. Title comparison
   needs the item's name, so it arrives with the meta lookup already planned for
   the runtime-based size check. As built in phase 2:
   - The meta lookup (cached, through the addon layer, run alongside the
     streams; a failure never fails the list) is limited to `movie` and
     `series`: channels and TV have no names or runtimes that mean anything to
     ranking.
   - Titles match loosely: case, accents, punctuation, a leading article and a
     trailing `(year)` are ignored, and the name only has to appear in one of
     the release lines (file name, then pack name). A line stating the item's
     year (±1, for releases around New Year) counts as a translated title, not
     a mismatch; so does a line naming exactly the requested episode.
   - Default penalties (`release.episodeMismatchPenalty`,
     `release.titleMismatchPenalty`): `10000` and `20000`, far below any
     matching playable candidate. Season and complete packs containing the
     episode are not penalised; episode numbers without a season prove nothing.
8. Also, as built: a small bonus for resolution up to `liveMaxHeight` (so 480p and
   1080p don't tie), a penalty for candidates that only play when prepared (live
   ones first), and a large penalty for CAM/telesync/screener releases.

Related: [[concept/addon-aggregation]], [[concept/ranking-settings]], [[decision/auto-select-and-fallback]], [[decision/destructive-items-flagged]], [[architecture/normalized-addon-types]], [[concept/engine-descriptor]], [[architecture/last-source-per-item]].
