---
type: Component
title: "Preparing a stream for playback: steps, unplayable reasons and the resolution matrix"
description: "The five prepare steps (engine session id, resolve mediaURL, probe, create the session, warm the start), the probe-caching hazard, the table of unplayable reasons with retryability, and the matrix mapping a raw Stream to a mediaURL."
tags: [core, engine, prepare, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth for preparing a stream for playback  Interface and overview: [[architecture/engine-module]].

1. **Session id:** look up `(engineId, sessionKey, hash(stream), quality)` in
   the `engine_sessions` table (the hash is SHA-256 over the raw stream's
   canonical JSON; the quality is what the engine will apply, empty without
   `sessionOverrides`). If it isn't there, mint a random 22-char base64url
   `sid`.
   - The same playback session and source reuse their engine session
     (idempotent; a prepared session is found again when it's played).
   - A new source gets a new `sid`, because server-go binds `mediaURL` to the
     id on first use.
   - Playback sessions don't share engine sessions. Seeking doesn't require
     that, since segments are independent ([[architecture/engine-hls-model]]). The reason is **lifecycle**:
     each playback session is prepared and retained on its own schedule.
2. **Resolve `mediaURL`** (matrix below). Torrents call `POST /{ih}/create`
   first, also when the stream has a `fileIdx` (to add the torrent and wait for
   its metadata).
3. **Probe** with `/hlsv2/probe`. Failure, or zero duration for VOD → unplayable.
   Record height/width/codec/duration in `status.info` (HDR too, if an engine
   ever reports it; server-go's probe doesn't, [[architecture/engine-endpoints-core-uses]]). As built, the probe's
   audio streams and text subtitle streams (the codecs server-go converts to
   WebVTT) become the session's `tracks` ([[architecture/playback-session]]), in server-go's rendition
   order (`audio<k>.m3u8`, `sub<k>.m3u8`). If the probe finds the real
   resolution is above the engine's `liveMaxHeight` and `mode` is `play`,
   return unplayable (`reason: 'needs-prepare'`), in case the release name was
   misleading. Zero duration on a playlist URL (or `format.name` `hls`) means
   live (`reason: 'live'`).
4. **Create the session:** `GET /hlsv2/{sid}/master.m3u8?mediaURL=…` (plus the
   quality overrides on an engine with `sessionOverrides`), and store
   `{sid, engineId, sessionKey, streamHash, quality, mediaURL}`. Any status
   but `200` is unplayable (`engine-error`); a `400` there means an override
   the engine refused.
5. **Warm the start.** On an engine with a transcode-ahead window ([[process/engine-upstream-prs]]), ask
   for it on the master request and let the engine read ahead. Otherwise core
   fetches `seg0`–`seg2` (or the video-only and default-audio equivalents) in the
   background and discards them. As built: from the master, every variant
   playlist and the default audio rendition, then the first three segments of
   each, read to the end (the engine caches a segment only once its transcode
   completes); failures are logged at `debug` and ignored.

**Probe caching hazard.** The engine caches a successful probe per URL. If the
host answers the first request with something else (a debrid or addon
placeholder; seen once, 2026-10-06, [[process/risk-register]] R33), the wrong duration, height and
tracks stick, and a retry of the same source reuses them. Core doesn't compare
the probe with the meta's runtime yet.

**Unplayable reasons** (as built; `failureReason` on a picked-source session,
[[decision/auto-select-and-fallback]] for auto-select). "Retryable" means a later attempt may succeed; auto-select
retries only torrents.

| Reason | When | Retryable |
|---|---|---|
| `unsupported` | A kind the module doesn't handle: archives, NZB, player frames, a non-http(s) URL, an invalid stream | no |
| `external` | `externalUrl` only | no |
| `live` | Zero duration on an HLS source (phase 4) | no |
| `needs-prepare` | The probed height is above `liveMaxHeight` in mode `play` | no |
| `probe-failed` | The probe failed, or found zero duration for VOD | torrents only (peers may still arrive) |
| `torrent-failed` | No metadata within `STREMIO_CREATE_METADATA_TIMEOUT` (`504`, retryable), or no usable file index (not retryable) | see left |
| `engine-offline` | The engine is unknown, its last health check failed (an answer to any other request re-checks it at once, [[architecture/engine-transport-and-health]]), or it didn't answer (refused, timed out, no connection within `ENGINE_CONNECT_TIMEOUT_MS`) | yes (not for an unknown engine), but auto-select stops |
| `engine-error` | The engine answered with an unexpected status | yes, except a `4xx` on the master |
| `engine-busy` | The torrent create got `503` (the engine is at `STREMIO_MAX_ENGINES`, default 20, with no idle torrent to evict), and again after waiting its `Retry-After` once (capped at 10 s) | yes, but auto-select skips the remaining torrents and tries only non-torrent sources; the session fails `engine-busy` if none plays |

Core adds `no-candidates`, `attempts-exhausted` and `candidates-exhausted`
(auto-select, [[decision/auto-select-and-fallback]]), `interrupted` (a session left resolving when core
stopped, [[architecture/playback-session]]) and `internal-error` (a bug; logged).

**Resolution matrix** (raw `Stream` → `mediaURL`; `127.0.0.1` is from the
engine's own point of view, with the port from its `address`, [[architecture/engine-endpoints-core-uses]]):

| Stream | mediaURL |
|---|---|
| `infoHash` (+ `fileIdx`, `sources`) | `POST /{ih}/create` with `peerSearch.sources` (`announce` entries, bare tracker URLs prefixed `tracker:`) and, if `fileIdx` is missing, `guessFileIdx`/`fileMustInclude` (the stream's own, else from `behaviorHints.filename`) → `http://127.0.0.1:11470/{ih}/{idx}?tr=…` (one `tr` per tracker source, [[architecture/engine-endpoints-core-uses]]) |
| `url`, direct file (debrid, HTTP) | The URL itself (must resolve to a public IP). All fetches come from the engine's IP, which suits debrid providers. |
| `url` + `behaviorHints.proxyHeaders` | `http://127.0.0.1:11470/proxy/stream?d=<b64url>&h_…=…&r_…=…`, plus `&api_password=…` when the descriptor has a `proxyPassword` ([[architecture/secrets-policy]]). The password is added on the way out (probe and master requests), not stored with the `mediaURL`. |
| `url` VOD HLS (`.m3u8`, probe has a duration) | The URL itself |
| `url` live HLS (probe duration 0) | Live mode ([[architecture/media-gateway]], phase 4). Until then → unplayable. |
| `ytId` | `http://127.0.0.1:11470/yt/{ytId}` (yt-dlp → 307). Progressive formats only. |
| `url` on the engine's own `local-addon` | The URL itself: an HTTP URL with #32 and `STREMIO_LOCAL_FILES_PUBLIC_URL` set, otherwise a `file://` path. Must run on that engine ([[architecture/future-remote-engines]]). |
| `externalUrl` | unplayable |

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]].
