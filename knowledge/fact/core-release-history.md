---
type: Fact
title: Core release history and the breaking-change record
description: "Core's tagged versions (0.1.0, 0.1.1, 0.1.2, 0.1.3, 0.1.4) with dates and what changed, plus the response-enum changes that oasdiff flagged and the maintainer accepted, so future API checks know the baseline."
tags: [core, releases, changelog, fact]
generated: { by: agent/mcp, at: "2026-10-10T03:05:23Z" }
status: stable
---

Source: CHANGELOG.md. These releases were tagged `core-vX.Y.Z` in the repository Multitap was first built in; this repository starts at `v0.2.0` ([[decision/core-public-repo-fresh-history]]).

- **core-v0.1.0** (2026-10-04, end of phase 2): library writes, profile settings, per-request language, track list and `audioTrack`, `bingeGroup` auto-next, streams in meta, addon preview, default addons, last source per item, aggregated search, subtitle offsets, backups, rotating logs, explain. Breaking relative to phase 1: `metrics` added to `ApiKey.scope` (accepted 2026-10-01, admin clients only), and addon `status` gained `needs-configuration`.
- **core-v0.1.1** (2026-10-06): safety flags (`destructive`), uncached debrid ranking, faster recovery when an engine returns, engine connect timeout, meta deep-link leak fixed.
- **core-v0.1.2** (2026-10-06): `GET /v1/whoami`, so the client can identify its own key.
- **core-v0.1.3** (2026-10-10, phase 3 step 0): per-item player state, `GET`/`PUT /v1/profiles/{id}/items/{type}/{itemId}/state` (migration 0011, table `item_player_states` keyed by profile and item id; `playerState` on library items; a session with `profileId` takes the stored audio language and seeds the subtitle offset for the chosen addon file). Additive; `api:diff` also flags two pattern warnings on `POST`/`PATCH /v1/profiles` because the profile-name pattern now spells whitespace out (U+00A0 mismatch found by the contract run). Tagged on branch `phase-3` and the tag pushed to `nas`; `main` gets the commits with the phase 3 merge.
- **core-v0.1.4** (2026-10-15, engine-asks work during phase 3): the media gateway retries an engine `502`/`504` on a segment once (upstream PR #53), and a torrent create refused with `503` (`STREMIO_MAX_ENGINES`) is retried once after `Retry-After` (capped at 10 s), else fails with the new `failureReason` `engine-busy` (a string, so no schema change; `api:diff` reports nothing). Tagged on `phase-3`, tag only pushed to `nas`.


**Accepted response-enum changes:** `metrics` on `ApiKey.scope`; `needs-configuration` on addon status (accepted 2026-10-04); `only-flagged` as a failure reason in 0.1.1 (no breaking report).

**Rule:** a breaking `/v1` change needs a minor bump and a changelog note. An additive one needs neither. Multitap is 0.x, so no stability is promised between minor releases. The API diff baseline is the latest `v*` tag.

Related: [[process/core-release]], [[architecture/core-v1-api]].
