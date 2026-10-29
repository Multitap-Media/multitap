---
type: Architecture
title: "Media gateway: URL scheme, status codes, retry, cost and live"
description: "Core's media listener on its own port: the /media URL scheme with its filename allowlist, relative playlists, check order and status codes, the one-time segment retry (2026-10-14), Range handling, cost, and live (phase 4). Proxy behaviour is a separate concept."
tags: [core, gateway, media, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/gateway/"
status: stable
---

Source of truth for the media gateway's URL scheme  Proxy behaviour is in [[architecture/media-gateway-proxy]].

All media a browser plays goes through core's media listener (`8081`), usually
from another origin. Engines never see a browser request, and neither does
the client.

#### URL scheme

```
/media/{mediaToken}/master.m3u8        → engine master (self-healing)
/media/{mediaToken}/{file}             → engine /hlsv2/{sid}/{file}
   file ∈ (playlist|video|audio\d+|sub\d+)\.m3u8 | (a\d+)?seg\d+\.ts | sub\d+\.vtt
   (planned, ladder engines, okf:architecture/rendition-and-bandwidth: also r\d+\.m3u8 and r\d+seg\d+\.ts; the engine's
    exact names are settled in its PR)
/media/{mediaToken}/ext/sub/{fileId}.vtt[?offsetMs=] → an addon subtitle for the session's item, as WebVTT,
                                          shifted by the session's offset plus offsetMs (okf:architecture/core-v1-api)
/media/{mediaToken}/stream             → direct play or remux sessions only (okf:concept/delivery-modes): the source
                                          bytes with Range passed through, or the remuxed stream
```

- All child URIs in server-go's playlists are **relative**, so hls.js resolves
  them under the same `/media/{mediaToken}/` prefix. No playlist rewriting is
  needed.
- The token names the playback session, and a session plays one source, so
  old and new sources can't be mixed.
- A released session returns `410`; the client then asks its backend what's
  playing now.
- An expired token returns `401`; the client gets a fresh token and reloads the
  master at its current position ([[concept/media-tokens]]).
- A bad, revoked or unknown token returns `404`, like any unknown path, and so
  does a session that isn't `ready` yet (addon subtitles under `ext/sub/` are
  served while it resolves), and one deleted after `SESSION_RELEASED_KEEP_MS`.
- As built, the checks run in this order: filename allowlist, token (signature,
  `exp`, released, epoch, subject), session state, engine. An engine `404`
  (evicted, past the end) passes through as `404`; any other engine error is a
  bare `502`, and an engine timeout a `504`, with no body, since engine error
  texts can name the engine session.
- **A failed segment is retried once** (2026-10-14: a few seconds, and
  the failure may be temporary). An engine `502` or `504` on a segment is
  retried for any session: with #53 ([[process/upstream-engine-asks]]) that is how the engine reports a
  source failing mid-stream (the reference engine's test saw an origin `429`) or a
  transcode past its deadline. An engine `404` is retried only for a session
  that has served a segment since core started (as built, 2026-10-01), since an
  engine without #53 answers `404` both for a missing segment and for a failed
  source. A second failure passes on as above. Playlists and subtitles aren't
  retried.
- **`Range` is ignored on transcode media** (as built in phase 2): playlists,
  segments and subtitles are always sent whole with `200`, and `HEAD` gets the
  headers. hls.js doesn't range these files; byte ranges matter for `stream`
  ([[concept/delivery-modes]]), which passes them through when it's built.

#### Cost

With 10 viewers at 10–12 Mbps, about 120 Mbps passes through Node on the docker
host. That's trivial for a streaming pipe. Latency is one extra LAN hop, well
under 1 ms. The time to first byte is dominated by the transcode. The path is
the same as it would be through a proxy (engine → docker host → internet); only
the process doing the copy changes.

#### Live (phase 4)

For live HLS, the engine module returns a live handle that uses server-go's
`/proxy/hls/manifest.m3u8?d=…`. The gateway proxies it under the same
`/media/…` scheme, allowing the proxy's rewritten child paths. There's no
transcode. The player detects a live playlist (no `EXT-X-ENDLIST`); the client
switches the room to live sync.

Related: [[architecture/media-gateway-proxy]], [[concept/media-tokens]], [[architecture/core-deployment]], [[architecture/engine-module]], [[concept/delivery-modes]].
