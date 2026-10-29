---
type: Process
title: "Core adversarial review (2026-10): summary, verdict and release blockers"
description: "Outcome of the six-area adversarial review of core: 3 high, 30 medium, 56 low and 32 info findings; the parity and design verdicts; the public-release blockers; disputes settled; and how the findings were verified."
tags: [core, review, security, parity, release, summary]
generated: { by: agent/mcp, at: "2026-10-20T16:55:09Z" }
status: draft
---

Summary of the [core adversarial review](charter.md), written by the orchestrator on 2026-10-20 after all six areas finished. Each finding's detail is in its own concept, linked from its area's progress concept.

## Verdict

**Not ready to publish yet, but close, and the remaining work is bounded.** No critical findings.
- **Access control is sound.** No route can be reached with less than its scope, there is no auth bypass, token verification is correct, and no secrets reach responses or `info` logs.
- **Hostile addons are the real exposure.** They can steer core's own fetches at the LAN and the engine, and freeze its event loop.
- **Data safety and publishing need work.** Upgrades are not safe, the licence is missing, the compatibility promise isn't enforced, and a fresh install assumes the maintainer's setup.

- **Parity: yes, core does most of the basics.** The protocol layer is a faithful port of stremio-core's addon handling, checked against the Rust source and against real Cinemeta and OpenSubtitles v3. Library rules and the watched bitfield match. The gaps are in what core passes on to clients (stream subtitles, `externalUrl`, live) and what clients can read back (per-episode watched, notifications). See the [parity matrix](parity-matrix.md).
- **Architecture: no structural flaw.** The API is coherent and contract-first, and the boundary rule holds: no app concepts in core. The one design flaw with user impact is [one player model per profile](bugs-library-one-player-per-profile.md), which corrupts watched state when two devices of one profile play at once. The rest are conventions and readiness: the [error model](design-api-error-model.md), [list conventions](design-api-list-conventions.md) and [test gaps](design-api-test-gaps.md).

## Counts after verification

| Area | High | Medium | Low | Info | Progress |
|---|---|---|---|---|---|
| sec-access | 0 | 2 | 7 | 6 | [progress](sec-access-progress.md) |
| sec-input | 3 | 2 | 3 | 4 | [progress](sec-input-progress.md) |
| bugs-playback | 0 | 5 | 7 | 3 | [progress](bugs-playback-progress.md) |
| bugs-library | 0 | 8 | 15 | 6 | [progress](bugs-library-progress.md) |
| parity | 0 | 6 | 11 | 7 | [progress](parity-progress.md) |
| design-api | 0 | 7 | 13 | 6 | [progress](design-api-progress.md) |
| **Total** | **3** | **30** | **56** | **32** | |

## Public-release blockers

**Security (hostile addons):**
1. [Addon requests follow redirects to private and loopback hosts](sec-input-addon-redirect-ssrf.md) (high).
2. [Subtitle file fetch reaches private and loopback hosts](sec-input-subtitle-ssrf.md) (high).

   For 1 and 2: one address guard on core's two outbound fetch sites fixes both. Before the fix, a single catalog response could make core call the engine's `GET /removeAll` and stop playback for every viewer.
3. [Quadratic regexes on addon text freeze core](sec-input-redos.md) (high). Needs linear patterns and a length cap on addon strings.

   **1 to 3 were fixed on 2026-10-20:** the [addon private-host guard](../architecture/addon-private-host-guard.md) (`ADDON_PRIVATE_ALLOW` for LAN hosts), linear patterns and a 4096-character cap on stream text. Their PoCs now pass as normal tests.

**Data safety on upgrade:**

4. [A migration cut short leaves core unable to start](bugs-library-migrations-not-atomic.md) and [upgrades migrate in place with foreign keys on and no backup](design-api-migration-safety.md). Both must land before the first public release that ships a migration. **Fixed 2026-10-20.**
5. [Graceful shutdown never finishes while an SSE client is connected](bugs-playback-shutdown-hangs-on-sse.md). Recent watch progress is lost on every restart. Small fix. **Fixed 2026-10-20.**

**Publishing:**

6. [No licence](design-api-no-licence.md). Choosing one is the decision. Fixed 2026-10-20: AGPL-3.0-only for core, MIT for the client packages ([[decision/core-licence]]).
7. [The /v1 compatibility guard isn't in CI, and the versioning promise contradicts itself](design-api-versioning-not-enforced.md). Fixed 2026-10-20 (see the finding's Resolution).
8. [A fresh install and its docs assume the maintainer's deployment](design-api-owner-specific-defaults.md): the seeded reference engine, the README and the wording. Fixed 2026-10-20, except the product name in the API title and User-Agent (see the finding's Resolution).

## Fix soon after (not blockers)

Since 2026-10-25 these are tracked as items in `ROADMAP.md` (Next, "Core review findings (2026-10)"), which is the live list; the first two are fixed.

- **Security weaknesses:**
  - [Open /v1/events streams outlive key revocation](sec-access-sse-outlives-key-revocation.md). **Fixed 2026-10-25:** the stream re-checks its key on every wake-up and ends once it is revoked.
  - [The /v1 listener binds every interface over plain HTTP, with no warning](sec-access-api-listener-public-default.md). **Fixed 2026-10-25:** core warns at startup (the default bind is unchanged).
  - [Addon data is cached by count, not bytes](sec-input-unbounded-memory.md).
  - [The proxy plan merges the engine's two private allowlists](sec-input-engine-proxy-password.md). **Fixed 2026-10-26 (0.2.0):** the password goes only on the `/proxy/stream` URL core builds, its target must pass the private-host guard, and addon URLs on loopback or the engine's host are refused.
  - [Segment requests run engine transcodes with no bound](bugs-playback-detached-segment-amplification.md). Fix before media tokens go to people the operator doesn't trust.
- **Bugs users will see:**
  - [One player per profile](bugs-library-one-player-per-profile.md).
  - [A playback never stopped is never unloaded](bugs-library-no-idle-unload.md).
  - [Marking the playing episode watched is undone](bugs-library-mark-playing-watched-undone.md).
  - [Incremental source lists drop early partials](bugs-library-incremental-partials.md).
  - [Torrent keys ignore the file choice](bugs-library-torrent-key-file-choice.md).
  - [Session identity ignores the engine and highRes](bugs-playback-identity-ignores-engine-highres.md).
  - [Orphaned engine sessions](bugs-playback-orphaned-engine-sessions.md).
  - [Last-Event-ID replay after a restart](bugs-playback-sse-replay-after-restart.md).
  - Ranking: [DV 5.1](bugs-library-dv-channel-layout.md) and [subtitle tags read as audio](bugs-library-subtitle-tags-as-audio.md).
- **Parity gaps a client builder hits:**
  - [Cinemeta's metasDetailed catalogs always fail](parity-metas-detailed-catalogs.md).
  - [A stream's own subtitles are dropped](parity-stream-subtitles-dropped.md).
  - [Per-episode watched is readable only through the bitfield](parity-per-video-watched.md).
  - [externalUrl streams can't be opened](parity-external-url-hidden.md).
  - [Live sources rank playable but fail](parity-live-sources.md).
  - [No notifications or calendar](parity-notifications-calendar.md).

## Disputes and corrections settled

- **sec-input engine proxy password: high → medium.** The verifier showed that any addon stream with `proxyHeaders` already gets a core-built `/proxy` URL carrying the password, and the password never leaves the core-to-engine link. The real issue is the merged allowlists. See the finding.
- **bugs-library torrent key: kept at medium, no longer a blocker.** A pick by key fails safely with `candidate-mismatch`; only auto-select can race into another file.
- **sec-input outbound SSRF: superseded.** It was an early umbrella write-up, fully covered by blockers 1 and 2, and is now marked deprecated. Don't count it.
- **Parity I4 (ROADMAP misreads stremio-core): the parity worker is right.** `meta_details.rs` asks every addon (`AggrRequest::AllOfResource`, line 721) and shows the first ready one. The ROADMAP item in `ROADMAP.md` (around line 200) should be corrected; it is a docs follow-up.

## How it was verified

- **Workers.** Six worker sessions, one per area. They read code and wrote PoC tests in `packages/core/test/review-poc/<area>/`.
- **PoC run.** The whole folder gave 13 passed and 52 expected fails (`pnpm vitest run packages/core/test/review-poc`), before the 2026-10-20 fixes moved the sec-input SSRF and ReDoS PoCs into the normal suite (and the 2026-10-25 fixes the two sec-access medium PoCs).
- **Flip check.** The orchestrator copied the PoCs, turned every `it.fails` into `it`, and checked that all 52 then fail on the assertion that shows the bug, not on setup.
- **Independent verifier.** A separate agent tried to refute the high findings and the two medium blocker candidates, re-running PoCs, timing the regexes and reading the engine's code. Its results are recorded in each finding under "Orchestrator verification".
- **Real runs.** The parity worker checked Cinemeta and OpenSubtitles v3 for real. Nothing was run against the reference engine. The playback findings are reproduced with the fake engine.

## Docs follow-ups found along the way

- Fixed 2026-10-20: `ROADMAP.md`'s stremio-core meta-aggregation claim (above). The item now says that only latency differs.
- Fixed 2026-10-20: the [secrets policy](../architecture/secrets-policy.md) names backup downloads as the admin exception (sec-access I3).
- [Engine private-host allowlist](../architecture/engine-private-host-allowlist.md) should say that the two allowlists are only separate when the proxy password is set (sec-input info 4).
