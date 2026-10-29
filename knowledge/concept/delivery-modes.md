---
type: Component
title: "Delivery modes: direct, remux, transcode"
description: "How media reaches players: direct play, remux and transcode; core picks the cheapest that works from client capabilities and the engine probe; watch parties always transcode."
tags: [core, delivery, transcode, remux, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/sessions/"
  - "packages/core/src/gateway/"
status: stable
---

Source of truth for delivery modes 

Transcoding every session is the right default for a watch party but wasteful for a single viewer whose player can already decode the source. Stremio's own clients avoid it: stremio-video's `canPlayStream` probes the stream and plays it as-is when the browser can. Core does the same, per session.

| `delivery` | What the engine does | What the gateway serves | Cost |
|---|---|---|---|
| `direct` | Nothing beyond fetching: the torrent file stream, or its proxy for HTTP sources | The original bytes, byte ranges passed through, behind the media token | Nearly free; no bitrate cap |
| `remux` | Copies the video stream and converts only what the player can't take (usually the audio to AAC, and the container) | A stream in a container the player accepts | Light: audio encode only |
| `transcode` | Today's full HLS transcode ([[architecture/engine-hls-model]], [[architecture/engine-module]]) | HLS ([[architecture/media-gateway]]) | The expensive path this design is sized around |

- **The client says what it can play.** A session request carries the player's capabilities: for a browser, what `MediaCapabilities` / `MediaSource.isTypeSupported` report (containers, video codecs with profile, bit depth, maximum size and HDR, audio codecs); for a native or mpv-based player, simply "everything". A client may also give a maximum bitrate.
- **Core picks the cheapest delivery that works**, using the engine's probe of the source ([[architecture/engine-prepare-stream]]): `direct` when the container, video and audio are all playable and within the bitrate limit; `remux` when the video is playable but the container or audio isn't; otherwise `transcode`. A client can also ask for a specific delivery; core answers `422` if that one can't work for the source.
- **No capabilities means `transcode`.** A request without them, or with `delivery: 'auto'` and nothing to go on, behaves exactly as sessions always have, so the default stays safe.
- **A watch party forces `transcode`.** Sync needs every viewer on the same rendition and segment timeline, and the bitrate cap for the weakest viewer ([[architecture/rendition-and-bandwidth]]) only exists on the transcode path.
- **Tokens and the gateway work the same way for all three.** A direct or remux session's token opens a single stream path instead of an HLS tree ([[architecture/media-gateway]]); revocation, expiry, telemetry and CORS are unchanged, with `Range` passed through for direct play ([[concept/media-tokens]]).
- **Remux needs an engine change.** server-go never uses `-c:v copy`; its HLS path re-encodes every segment. Remux is on the fork-or-upstream list next to GPU decoding ([[process/engine-upstream-prs]], Planned engine changes). Stream copy doesn't fit server-go's fixed 4 s segments, because source keyframes don't land on segment boundaries, so remux needs its own output: keyframe-aligned HLS segments of varying length (built from the source's keyframe index), or a progressive fragmented-MP4 stream restarted on seek. That choice is made when remux is built.
- **Status:** phase 2 declares `delivery` in the session API with all three values and builds only `transcode` ([[process/build-plan]]); requesting `direct` or `remux` returns `501` until they exist. Direct play (capability detection in the client, the gateway's byte-range path) comes later, then remux once the engine supports it.

Related: [[architecture/playback-session]], [[process/engine-upstream-prs]].
