---
type: Architecture
title: "Engine endpoints core uses, and engine facts core relies on"
description: "The stremio-server-go endpoints core calls, how core detects DELETE and /opensubHash support, builds engine-local mediaURLs (and warns about a port that may not be the engine's own), picks the torrent file and keeps trackers; plus the torrent idle-timeout lifecycle."
tags: [engine, endpoints, core, torrent]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T02:45:00Z" }
code_refs:
  - "packages/core/src/engines/server-go.ts"
  - "packages/core/src/engines/server-go-types.ts"
  - "packages/core/src/engines/resolve.ts"
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
| `POST`/`GET`/`DELETE /hlsv2/{sid}/prepare` | Engine-side preparation (#73, `RIVULET_HLS_PREPARE`): start or re-check the job (`?audio=default\|all`), read its status, stop it. Detected with `DELETE /hlsv2/{invalid id}/prepare`: `400` with the feature, `404` or `405` without ([[architecture/engine-prepare-ahead]]) |
| `GET /yt/{id}` | yt-dlp resolve → 307 to a progressive format (usable as `mediaURL`) |
| `GET /proxy/stream?d=…&h_<Header>=…&r_<Header>=…[&api_password=…]` | Wrap HTTP sources that need `behaviorHints.proxyHeaders`. With `STREMIO_PROXY_PASSWORD` set, a request without the matching `api_password` is refused ([[architecture/secrets-policy]]). |
| `GET /proxy/hls/manifest.m3u8?d=…`, `GET /proxy/stream/segment.{ext}?d=…` | Live HLS ([[architecture/media-gateway]]): the proxied playlist, whose children core renames, and its segments; keys come through `/proxy/stream`. `h_`/`r_` and `api_password` as for `/proxy/stream`. An engine without it answers Go's `404`, and a live source then fails with `live`. `POST /generate_url` (signed URLs) isn't used |
| `GET /local-addon/…` | Local-files addon (future: engine-local content, [[architecture/future-remote-engines]]) |
| `GET /metrics` | Prometheus gauges for the admin health view; also core's health check ([[architecture/engine-transport-and-health]]) |

**The all-zero info hash never reaches an engine.** The addon protocol accepts it, but on engines before v0.28.0 `POST /{infoHash}/create` panics in anacrolix with the engine's manager lock held and no deferred unlock, which upstream reports hangs later requests (fixed by upstream `a2949a6`). The hang was read from source, not reproduced. `planStream` classifies such a stream as `unsupported`, so auto-select moves on to the next source, and the client's `checkInfoHash` refuses it as well. That second check alone isn't enough: it throws a plain error, which would end auto-select with `internal-error`.

`/{infoHash}/remove` isn't used: a torrent can back several sessions, so torrents are reclaimed by the idle timeout (below).

**Engine facts core relies on** (learned building phase 2):
- **Health:** a `200` from `GET /metrics` means the engine is up. It's cheap and needs no session or torrent.
- **Detecting `DELETE` (#24):** core sends `DELETE /hlsv2/..capability-probe` once per engine. The id contains `..`, which server-go's `validSessionID` rejects, so an engine with #24 answers `400` and one without it routes the request to its generic `404` (`405` counts the same). The answer is cached until the engine next comes back online (it may have been upgraded); a failed probe isn't cached.
- **Detecting `/opensubHash`:** a `405`, or a `404` with Go's generic `404 page not found` body (no such route), means the engine lacks it; that's cached until the engine next comes back online. Any other `404` is about that file and turns nothing off.
- **Engine-local URLs:** the `mediaURL`s core builds for the engine's own endpoints (torrents, `/yt`, `/proxy/stream`) use `http://127.0.0.1:{port}`, with the port taken from the engine descriptor's `address` (default `11470`). That's the loopback listener the SSRF guard lets through ([[architecture/engine-hls-model]], [[architecture/engine-security-posture]]). They're right only when the engine itself listens on that port: with a remapped container port, or a proxy in front on another port, those sources fail. The descriptor has no field for the engine's own port, so the health monitor logs a warning (once per address) when the address's port, explicit or the scheme's, isn't `11470`.
- **Torrent file choice:** without a `fileIdx`, core asks for `guessFileIdx` and passes `fileMustInclude`: the stream's own list if it has one, otherwise a regex built from `behaviorHints.filename` that matches the torrent-relative path's last component (`/(?:^|/)Name\.mkv$/`; server-go reads an entry as a regex only in `/…/flags` form, anything else as a literal substring).
- **Trackers in the torrent `mediaURL`:** `/{ih}/{idx}?tr=…` repeats the create's tracker sources (as stremio-core's streaming URLs do). The engine reopens a torrent from `mediaURL` alone after a restart (persisted sessions) or once its idle timeout dropped it, and without them a torrent known only to the addon's trackers finds no peers.

**Torrent lifecycle.** `STREMIO_TORRENT_IDLE_TIMEOUT` drops a torrent with no readers. Since nothing removes torrents explicitly, this is the reclaim mechanism. At **1 h**, a session paused for up to an hour resumes with its peers intact. A fully prepared session doesn't need its torrent at all, because every segment is already on disk.

Related: [[architecture/engine-module]], [[concept/engine-descriptor]], [[process/engine-upstream-prs]].
