---
type: Process
title: "Engine upstream PRs: what merged and what each adds"
description: "The stremio-server-go PRs by Multitap's maintainer (#24 to #36 and #49, #52, #57), merge dates and releases, what each gives core, the #33 pre-roll design, and the rule that every design falls back on an engine without them."
tags: [engine, upstream, prs, process]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth for the engine upstream contributions (migrated from the former design document; AGENTS.md "Working on the engine"). The still-planned engine work is in Planned engine changes; upstream review notes are in [[process/upstream-engine-asks]] and Engine verification details and open work.

Every PR was one commit, opt-in or bug-fix only, with defaults unchanged. Each was reviewed independently and passed the same steps as upstream CI on Linux (Verification setup for engine PRs). The maintainer merged #24–#29 on 2026-09-29, rebasing the stack and resolving the overlaps (for example, #27's tone-map trim now follows each attempt of #29's pre-roll retry). #33, #34, #35 and #36 followed on 2026-09-30. Later merges: the short-segment check (#52, with its follow-up #57) and the private-host allowlist for `mediaURL` (#49, merged 2026-10-16).

**The reference engine should run upstream v0.18.1 or later**, which has all of #24–#36. (v0.18.0 lacks the #34 fix that persistent preparations rely on.) Since 2026-09-30 the reference engine host runs `main` at `11be9eb` (v0.18.1 plus a CI-only commit); a session idle 95 s survived a service restart there. Phase 0 ran a local build with #24–#29 merged locally; the reference engine host now builds from an upstream tag or `main`, plus any change of ours still in review. The design still works on an engine without these changes (the fallback paths stay), and core detects each feature at runtime.

| # | Change | What it gives this project |
|---|---|---|
| #24 | `DELETE /hlsv2/{id}`; `STREMIO_HLS_SESSION_TTL=0` = never evict | Core-owned retention ([[architecture/engine-retention]]); the global TTL becomes a safety net |
| #25 | Opt-in per-session `ttl`, `maxWidth`/`maxHeight`, `bitrate`/`maxRate`/`bufSize` on `master.m3u8` (gate: `STREMIO_HLS_SESSION_OVERRIDES`) | Per-session quality ([[architecture/rendition-and-bandwidth]]); long TTL only for prepared sessions. `ttl` has a 60 s floor; with the gate on, overrides can also raise the env caps. |
| #26 | Opt-in persistent sessions under `STREMIO_HLS_WORK_DIR` (`STREMIO_HLS_PERSIST`), with an exclusive lock and a config fingerprint | Preparations survive engine restarts (R6). The TTL still applies, so it must be raised. |
| #27 | Opt-in HDR→SDR tone mapping (`STREMIO_TRANSCODE_TONEMAP`, `on` = mobius) | HDR10/HLG sources become watchable (R2). DV profile 5 is still skipped. |
| #28 | `STREMIO_TRANSCODE_QSV_PRESET`, plus `transcodeProfile` mapping to QSV | QSV quality/load tuning on the reference engine host |
| #29 | Don't cache empty or truncated segments; one 30 s pre-roll retry for MPEG-TS | No permanently broken segments, which matters most for prepared sessions ([[architecture/engine-prepare-ahead]]) |
| #33 (from issue #30) | Container-aware seek pre-roll: `STREMIO_HLS_SEEK_PREROLL` | 38–62% less time per 4K segment on MKV/MP4 with QSV encode (phase 0), with TS kept safe |
| #34 (v0.18.1) | Persisted sessions are restored by the TTL the reaper applies | With TTL `0` or a per-session `ttl`, v0.18.0 discarded sessions on restart; this makes #26 work with core's retention (R6) |
| #35 (v0.18.1) | Closes disk piece storage on `Close`; the engine's test suite passes on Windows | Engine changes can be checked on the dev machine's Windows too (Verification setup for engine PRs) |
| #36 | A `windows-latest` job in upstream's CI (merged after v0.18.1) | Windows regressions in the engine show up in CI |

No engine PR of ours is open (the former design document as of its last edit; later upstream review notes are in [[process/upstream-engine-asks]]).

**The #33 design**, following the maintainer's feedback on issue #30: ffprobe's `format_name` is matched against an allowlist of indexed containers (Matroska and MP4/MOV). `STREMIO_HLS_SEEK_PREROLL` sets the pre-roll for those only and can only shrink it (0–10 s); MPEG-TS, HLS, FLV, raw streams and anything unknown keep the full 10 s. With a shrunk pre-roll, a segment whose video is missing or late (a broken index, say, in a partial download) is re-transcoded once with the full 10 s, through #29's retry path. The pre-roll is part of #26's fingerprint, so a restored session whose margin changed re-transcodes rather than mixing segments. The default stays 10 s everywhere; the reference engine sets `0` (Reference engine configuration). A global pre-roll alone was prototyped and not submitted, because below the default it silently breaks MPEG-TS sources ([[discovery/ffmpeg-mpegts-seek-next-keyframe]]).

**Rule.** Every change is one commit per PR, opt-in or bug-fix only, defaults unchanged, and independently reviewed. Core detects each feature at runtime and falls back. See Engine changes go upstream first; fork only if upstream declines.

Related: [[architecture/engine-hls-model]].
