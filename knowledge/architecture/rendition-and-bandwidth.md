---
type: Architecture
title: One rendition per session; per-session quality and bitrate by height
description: "Today a session has one H.264 rendition; core lets a create set maxHeight and bitrate (capped by core), with a height-to-bitrate table; the room's quality must suit its slowest viewer."
tags: [core, bandwidth, quality, rendition, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/sessions/"
  - "packages/core/src/config.ts"
status: stable
---

Source of truth for one rendition per session and per-session quality (migrated from the former design document, the current-state part). The planned ABR ladder is in [[architecture/abr-ladder-core-api]] and [[decision/abr-ladder]].

**Today** the engine produces one H.264 rendition per session, capped at 1080p, and every token holder pulls the same one through the gateway. An ABR ladder is planned ([[process/engine-upstream-prs]], Planned engine changes); until an engine has it, everything in this section about one rendition stays true.

- **Upload is not the limit.** The link is 3 Gb symmetrical, and 10 viewers at 12 Mbps is 120 Mbps through core.
- **The slowest viewer is the limit** when a client makes viewers wait for each other, as the client's default buffering policy does. There's no ladder yet. **Choose the bitrate for the weakest friend's downlink.** A 10 Mbps maxrate is a good 1080p starting point.
- **Per-session quality.** A create request may carry `quality: { maxHeight?, bitrate? }`, so a client can size one session for its audience (the client: the weakest viewer in the room) without touching the engine's defaults.
  - It needs an engine with `sessionOverrides` (#25 with `STREMIO_HLS_SESSION_OVERRIDES=1`). Core passes the values as `maxHeight` and `bitrate` on the master request that creates the engine session.
  - **Core enforces the limits**, because the engine doesn't clamp overrides: `maxHeight` is capped at the engine's `liveMaxHeight`, and `bitrate` at `MULTITAP_SESSION_MAX_BITRATE` ([[architecture/configuration]]). A request above a cap is lowered to it, not rejected. `MULTITAP_SESSION_MAX_BITRATE` is a plain ceiling with no other limit behind it: an operator with the upload for it may raise it to `50M` or more (#25 accepts up to `200M`).
  - **A height brings its bitrate** (found on the reference engine, 2026-10-01: 360p to 720p sessions all ran at 9–10 Mb/s, because without a per-session `bitrate` the engine's configured one applies at every height). A request with `maxHeight` and no `bitrate` gets one from `MULTITAP_SESSION_BITRATE_BY_HEIGHT` for the capped height: the first rung at or above it, else the top rung. The default table is `240=600k, 360=1M, 480=1.5M, 576=2M, 720=3M, 1080=6M, 1440=10M, 2160=16M`, a little above the usual streaming ladders for QSV's `veryfast`; every live rung stays below server-go's own default (8M). A derived bitrate is capped at `MULTITAP_SESSION_MAX_BITRATE` and at the engine's `defaultBitrate` when the descriptor has one, so it never raises what the engine would have used; `MULTITAP_SESSION_BITRATE_BY_HEIGHT=off` turns it off. The table is an environment variable (an operational limit read at startup, like `MULTITAP_SESSION_MAX_BITRATE`, [[architecture/configuration]]). The derivation doesn't know the source's own height (the probe runs later), so a 720p source asked for at `maxHeight: 1080` gets the 1080p bitrate.
  - The engine freezes a session's quality when it creates it. So `quality` is part of a session's identity (idempotency and the engine session id), and it can't be patched: a different quality is a new session and a new transcode. The identity uses the effective quality (capped, with the derived bitrate), so `{maxHeight: 720}` and `{maxHeight: 720, bitrate: 3000000}` find the same session, and the session's `quality` shows the derived bitrate.
  - On an engine without `sessionOverrides`, the request still succeeds with the engine's defaults; the session's `quality` is then absent and core logs a warning.
  - **Observed (2026-10-01, phone on mobile data, reference engine):** at full quality (engine 10M, video segments of about 9 Mbps) a weak cell signal stalled, with segments taking 5–7 s per 4 s; a session with `maxHeight: 480` (derived 1.5 Mbps) played smoothly. With one rendition, the room's quality has to suit its slowest viewer.

Related: [[architecture/engine-hls-model]], [[architecture/playback-session]], [[concept/delivery-modes]], [[architecture/configuration]].
