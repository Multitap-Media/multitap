---
type: Architecture
title: "Media gateway proxy behaviour: authorization, streaming, CORS, disconnects, telemetry"
description: "How the gateway proxies: in-process token authorization, unbuffered streaming and response headers, CORS, not aborting segment requests on viewer disconnect, several viewers on one transcode, timeouts, per-viewer telemetry, the browser CSP finding of 2026-10-01, and token hygiene in logs."
tags: [core, gateway, media, proxy, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/gateway/"
status: stable
---

Source of truth for the gateway's proxy behaviour  The URL scheme and status codes are in [[architecture/media-gateway]].

- **Authorization:** in-process, with no call out per request. Check the signature,
  `exp`, `tokenEpoch`, the subject denylist, and that the session isn't
  released. Verified tokens are cached briefly (60 s, as built), and session
  state (released, epoch) is kept in memory and updated on every change.
- **Streaming:** pipe the response through without buffering (as built, a web
  `ReadableStream` that pulls one chunk at a time and counts the bytes). Pass
  the upstream status, `Content-Type` and `Content-Length` through, and send
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff`.
- **Filename allowlist** as in [[architecture/media-gateway]]. Everything else is `404`, so engine APIs
  are never reachable through the gateway. The media listener serves nothing
  but `/media`.
- **CORS:** for an `Origin` in `MULTITAP_CORS_ORIGINS`, send
  `Access-Control-Allow-Origin` with that origin and `Vary: Origin`, expose
  `Content-Length` and `Content-Range`, and answer preflights (`GET`, `HEAD`,
  `Range`). No `Allow-Credentials`. Requests from other origins get no CORS
  headers, so browsers block them; non-browser clients are unaffected, since the
  token is the credential.
- **Viewer disconnects:** the engine kills an in-flight segment transcode if its
  triggering request goes away ([[architecture/engine-hls-model]]). For `.ts` requests, the gateway **doesn't
  abort the upstream request** when a viewer disconnects. It finishes and
  discards the result, so other viewers waiting on that segment aren't forced
  to start over. Playlists and VTT can abort normally. As built, a segment
  request is sent to the engine without the viewer's abort signal, and a
  segment whose viewer left (or a `HEAD` for one) is read to its end in the
  background.
- **Several viewers, one transcode:** every token of a session maps to the same
  engine session, so a second viewer never creates another. The gateway
  doesn't coalesce requests itself: it forwards each viewer's segment request,
  and the engine's per-segment lock ([[architecture/engine-hls-model]]) makes concurrent requests for one
  segment share one ffmpeg job and its cached output.
- **Timeouts:** segment requests may legitimately take as long as
  `STREMIO_HLS_SEGMENT_TIMEOUT` (slow software decode). Don't time out sooner
  (`MULTITAP_ENGINE_TIMEOUT_MEDIA_MS`, default 200 s, above the reference engine's 180 s).
- **Telemetry:** record the last segment requested and the bytes sent per token
  subject (`GET /v1/sessions/{id}/viewers`). That gives clients a cheap
  position and buffering signal for sync diagnostics, and bandwidth figures for
  an admin dashboard. As built it's in memory only (lost on restart), at most
  1000 subjects per session, and only video segments (`segN.ts`) count as the
  position. A released session answers `410` here.
- **A browser player's CSP** (found 2026-10-01): hls.js fetches playlists and
  segments with XHR/fetch, so the page's `connect-src` must include the media
  origin, and `media-src` needs `blob:`. A proxy's security-headers
  middleware that sets `connect-src` without the media origin makes hls.js
  fail (`manifestLoadError`, status 0) until the media origin is added; the
  client app's CSP must include it. The same middleware set COEP
  `require-corp`, COOP `same-origin` and CORP `same-site`: the media host is
  same-site, so it worked, but a player on another registrable domain would
  need CORP changes on the media responses.
- **Token hygiene:** the token is in the path. At `info` and above core logs the
  session id and subject instead of the path; at `debug` it logs everything
  ([[architecture/secrets-policy]]). A proxy in front of the media listener should drop or redact the path
  in its access log; that's the operator's policy.

Related: [[architecture/media-gateway]], [[concept/media-tokens]], [[architecture/engine-hls-model]], [[architecture/core-deployment]], [[architecture/secrets-policy]].
