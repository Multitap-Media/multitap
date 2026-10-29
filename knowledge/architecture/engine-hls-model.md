---
type: Architecture
title: stremio-server-go HLS transcode model
description: "How the engine transcodes: caller-keyed sessions, independent on-demand 4-second segments with 10 s pre-roll, software decode, one H.264 rendition, cache, eviction, probe cache, SSRF guard and tuning."
tags: [engine, hls, transcode, ffmpeg]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

This concept is the source of truth for the engine's HLS transcode model  It drives the engine module ([[architecture/engine-module]]) and gateway ([[architecture/media-gateway]]). Only core talks to engines. File and line references are to the local stremio-server-go clone, **reviewed at upstream `9475695` and current as of v0.18.1 (`7c637ad`)**; line numbers drift, so treat them as pointers, not anchors.

- **Sessions are keyed by a caller-chosen id.** `GET /hlsv2/{id}/master.m3u8?mediaURL=…` creates or reuses session `{id}` (`internal/api/api.go:1379`, `internal/media/hls.go:493`). Anyone using the same id shares the session and its on-disk segment cache. Core creates one id per **playback session** ([[architecture/engine-prepare-stream]]).
- **Each segment is transcoded independently, on demand.** Every 4 s segment (`internal/media/hls.go:22`) is its own `ffmpeg` run with a hybrid seek. The output is cached to disk, and a per-segment mutex dedupes concurrent requests (`internal/media/hls.go:1103`). Consequences:
  - The playlist is a full **VOD playlist** from the start, so any viewer can seek anywhere immediately. There is no "transcode head" to wait for.
  - Five viewers requesting `seg120.ts` at once produce **one** ffmpeg run.
  - Late joiners and rewinds are served from cache.
  - Each segment re-decodes about **10 s of pre-roll** (input seek at `start-10s`), so decoding does about 3.5× the work of the output. On MPEG-TS sources the pre-roll isn't always enough ([[discovery/ffmpeg-mpegts-seek-next-keyframe]]).
  - **Decode is always software** (no `-hwaccel`). QuickSync only encodes. Scaling (`scale=`) is also software.
  - The **request's context drives ffmpeg**. If the client that triggered a segment disconnects mid-transcode, that ffmpeg is killed and the next waiter starts over. The gateway accounts for this ([[architecture/media-gateway-proxy]]).
- **HLS tuning is configurable** (upstream `0d5f19a`, from our issue #20). Values are env vars parsed in `internal/media/config.go`. Our values are in Reference engine configuration.
- **Session idle eviction** (`STREMIO_HLS_SESSION_TTL`, default 60 s). Shaping retention ([[architecture/engine-retention]]):
  - The TTL is one global value. Before v0.18.0 it couldn't be turned off (`≤0` fell back to 60 s), there was no delete endpoint, and sessions never survived a restart (state was in memory, and each process used a new random `stremio-hls-*` directory that a clean shutdown deleted). An engine older than v0.18.0 still behaves that way.
  - From v0.18.0 this is configurable, all opt-in: `DELETE /hlsv2/{id}` and TTL `0` meaning never evict (#24), a per-session `ttl` (#25), and sessions that persist under `STREMIO_HLS_WORK_DIR` (#26). **Persistence with TTL `0` or a per-session `ttl` needs v0.18.1 or later** (#34); v0.18.0 discarded such sessions on restart.
  - Sessions with a transcode in progress are never evicted (`325cd3c`).
  - If a session is gone, the next master request recreates it, and segments re-transcode on demand.
- **Probe cache.** Successful ffprobe results are cached for 10 min (`STREMIO_HLS_POS_PROBE_TTL`). Failed probes are cached for `STREMIO_HLS_NEG_PROBE_TTL` (default 5 min). We use **30 s**, with a **60 s** probe timeout, so a torrent that's slow to find peers can be retried soon.
- **Output** (defaults at `internal/media/config.go:95`, filters at `:506`):
  - Video is always re-encoded to H.264. There is **no stream-copy path**.
  - One rendition per session. There is **no ABR ladder yet**; one is planned on the engine track ([[decision/abr-ladder]]).
  - Bitrate, maxrate and buffer size come from `STREMIO_TRANSCODE_*` env vars.
  - **Downscaling** is set with `STREMIO_TRANSCODE_MAX_WIDTH`/`_MAX_HEIGHT`. It keeps the aspect ratio and never upscales.
  - `BANDWIDTH` and the H.264 level in the master's `CODECS` are calculated from the effective maxrate and resolution once those are configured. `BANDWIDTH` is **half the maxrate** (upstream kept the old 8M → 4,000,000 ratio), so it understates the real peak: the reference engine's 10M maxrate advertises `BANDWIDTH=5000000` while its 1080p segments run at 9–10 Mb/s (an upstream ask, [[process/upstream-engine-asks]]; [[process/upstream-engine-asks]]).
  - The **QSV encoder preset** defaults to `veryfast`; `STREMIO_TRANSCODE_QSV_PRESET` (#28) changes it.
  - **HDR→SDR tone mapping is opt-in** (`STREMIO_TRANSCODE_TONEMAP`, #27; Tone mapping chain needs output primaries on the first zscale). Without it, 10/12-bit sources are converted with `format=yuv420p`, so HDR10 looks washed out. Dolby Vision profile 5 is skipped either way and shows wrong colours.
  - **Segments are checked before caching** (#29): empty ones, and ones whose video is missing or starts late, are served but not cached. The check doesn't catch a segment whose video ends early (the short-segment check; ffmpeg exits 0 on truncated input and pads audio silently).
  - The `/settings` keys `transcodeMaxBitRate`, `transcodeMaxWidth`, `transcodeConcurrency`, `transcodeHardwareAccel` and `transcodeProfile` override the env vars. **Core never writes them**, so the env vars are the only source of truth.
- **Multi-audio and subtitles come free.** With 2+ audio tracks, the master exposes an `EXT-X-MEDIA TYPE=AUDIO` group with video-only segments (`internal/media/hls.go:669`). Text subtitle tracks become WebVTT renditions; image subtitles (PGS/VobSub) are dropped. **Viewers pick their own audio and subtitle track while sharing one video transcode.**
- **Concurrency.** Concurrent ffmpeg segment jobs are capped by `STREMIO_TRANSCODE_CONCURRENCY` (default `NumCPU`, which is 8 on the reference engine host), and sessions by `STREMIO_HLS_MAX_SESSIONS` (default 64). If the hardware encoder fails, that segment **falls back to libx264** without any notice.
- **SSRF guard.** `mediaURL` must be http(s) on a public IP, **or** start with `http://127.0.0.1:11470` (`internal/media/media.go:358`). Anything served by server-go itself (torrents, `/yt`, `/proxy`, local files) passes. Remote fetches go through a **loopback media relay** that re-checks every connection, redirect and nested playlist (`c3be336`). Why it stays on: [[architecture/engine-security-posture]].
- **Live content is not supported by `/hlsv2`** (it needs a known duration). Live sources use `/proxy/hls/manifest.m3u8` ([[architecture/media-gateway]]).

Related: [[architecture/engine-security-posture]], [[architecture/rendition-and-bandwidth]], [[architecture/engine-endpoints-core-uses]], [[process/engine-upstream-prs]], Reference engine hardware and measured performance.
