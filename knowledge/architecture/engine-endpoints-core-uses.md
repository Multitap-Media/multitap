---
type: Architecture
title: "Engine endpoints core uses, and engine facts core relies on"
description: "The stremio-server-go endpoints core calls, how core detects DELETE support, builds engine-local mediaURLs, picks the torrent file and keeps trackers; plus the torrent idle-timeout lifecycle."
tags: [engine, endpoints, core, torrent]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/server-go.ts"
  - "packages/core/src/engines/server-go-types.ts"
status: stable
---

Source of truth for the engine surface core depends on  Only core talks to engines.

| Endpoint | Use |
|---|---|
| `POST /{infoHash}/create` (body: `peerSearch.sources`, `fileMustInclude`, `guessFileIdx`) | Add a torrent, wait for metadata (`STREMIO_CREATE_METADATA_TIMEOUT`, `504` when it runs out), resolve the file index (`guessedFileIdx` in the answer) |
| `GET /{infoHash}/{fileIdx}` | Torrent byte stream; used as the `mediaURL` for HLS |
| `GET /{infoHash}/{fileIdx}/stats.json` | Download speed, peers, progress for "preparing…" |
| `GET /hlsv2/probe?mediaURL=` | Pre-flight probe: duration, `format.name`, and per stream the track type, codec, size, language, default flag and profile. **No HDR or bit depth**: the reshaped answer leaves them out, so core can't confirm HDR from the probe. A failed probe is a `500`. |
| `GET /hlsv2/{sid}/master.m3u8?mediaURL=` | Create or reuse the HLS session (with #25's overrides on creation). Also self-heal. |
| `GET /hlsv2/{sid}/{file}` | Media playlists, segments, subtitle VTT (proxied by the gateway) |
| `DELETE /hlsv2/{sid}` | Release a session (#24) |
| `GET /yt/{id}` | yt-dlp resolve → 307 to a progressive format (usable as `mediaURL`) |
| `GET /proxy/stream?d=…&h_<Header>=…&r_<Header>=…[&api_password=…]` | Wrap HTTP sources that need `behaviorHints.proxyHeaders`. With `STREMIO_PROXY_PASSWORD` set, a request without the matching `api_password` is refused ([[architecture/secrets-policy]]). |
| `GET /proxy/hls/manifest.m3u8?d=…` + `POST /generate_url` | Live HLS passthrough (phase 4) |
| `GET /local-addon/…` | Local-files addon (future: engine-local content, [[architecture/future-remote-engines]]) |
| `GET /metrics` | Prometheus gauges for the admin health view; also core's health check ([[architecture/engine-transport-and-health]]) |

`/{infoHash}/remove` isn't used: a torrent can back several sessions, so torrents are reclaimed by the idle timeout (below).

**Engine facts core relies on** (learned building phase 2):
- **Health:** a `200` from `GET /metrics` means the engine is up. It's cheap and needs no session or torrent.
- **Detecting `DELETE` (#24):** core sends `DELETE /hlsv2/..capability-probe` once per engine. The id contains `..`, which server-go's `validSessionID` rejects, so an engine with #24 answers `400` and one without it routes the request to its generic `404` (`405` counts the same). The answer is cached until the engine next comes back online (it may have been upgraded); a failed probe isn't cached.
- **Engine-local URLs:** the `mediaURL`s core builds for the engine's own endpoints (torrents, `/yt`, `/proxy/stream`) use `http://127.0.0.1:{port}`, with the port taken from the engine descriptor's `address` (default `11470`). That's the loopback listener the SSRF guard lets through ([[architecture/engine-hls-model]], [[architecture/engine-security-posture]]).
- **Torrent file choice:** without a `fileIdx`, core asks for `guessFileIdx` and passes `fileMustInclude`: the stream's own list if it has one, otherwise a regex built from `behaviorHints.filename` that matches the torrent-relative path's last component (`/(?:^|/)Name\.mkv$/`; server-go reads an entry as a regex only in `/…/flags` form, anything else as a literal substring).
- **Trackers in the torrent `mediaURL`:** `/{ih}/{idx}?tr=…` repeats the create's tracker sources (as stremio-core's streaming URLs do). The engine reopens a torrent from `mediaURL` alone after a restart (persisted sessions) or once its idle timeout dropped it, and without them a torrent known only to the addon's trackers finds no peers.

**Torrent lifecycle.** `STREMIO_TORRENT_IDLE_TIMEOUT` drops a torrent with no readers. Since nothing removes torrents explicitly, this is the reclaim mechanism. At **1 h**, a session paused for up to an hour resumes with its peers intact. A fully prepared session doesn't need its torrent at all, because every segment is already on disk.

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[process/engine-upstream-prs]].
