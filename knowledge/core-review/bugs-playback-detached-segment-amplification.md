---
type: Finding
title: "Every segment request runs an engine transcode to its end, HEAD and dropped requests included, with no bound"
description: "The gateway reads every segment's engine response to its end even for HEAD and for viewers already gone, and nothing caps these detached reads, so a media token holder can queue a full transcode of every segment of a title with a burst of cheap requests."
tags: [core, review, bugs-playback, gateway, resource-exhaustion]
generated: { by: agent/mcp, at: "2026-10-20T13:15:46Z" }
code_refs:
  - "packages/core/src/gateway/app.ts"
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md); listed in [bugs-playback progress](bugs-playback-progress.md).

- **Severity:** medium. **Kind:** security (resource exhaustion through the gateway).
- **Verdict:** confirmed.

## Where

- `packages/core/src/gateway/app.ts:301-311`: segments are fetched with no signal, so the viewer's disconnect never reaches the engine.
- `packages/core/src/gateway/app.ts:358-362`: a `HEAD` (or a viewer already gone) gets `drain(upstream.body)`: the whole segment is read and dropped.
- `packages/core/src/gateway/app.ts:113-117`: a viewer that disconnects mid-segment detaches; the upstream is read to its end.
- `packages/core/src/gateway/app.ts:166, 183-186`: the `detached` set has no limit.

## What happens

Running a segment to its end after one viewer leaves is deliberate ([media-gateway-proxy](../architecture/media-gateway-proxy.md): server-go kills a transcode whose request goes away, and other viewers may wait on it). But nothing bounds it, and `HEAD` takes the same path. A media token holder (a browser, untrusted under the [charter](charter.md)'s threat model) can send `HEAD /media/{token}/seg0.ts` … `segN.ts` for every segment of a two-hour title (about 1800 requests), or GETs it drops at once. Each answer costs the client nothing, while core starts one engine transcode per segment and reads each to the end. The engine's `STREMIO_TRANSCODE_CONCURRENCY` queues them, so every other session on that engine stalls behind about an hour of queued transcodes. Revoking the token doesn't stop the reads already detached.

## Evidence

`packages/core/test/review-poc/bugs-playback/gateway-detached-segments.test.ts` builds the media app with a fake engine whose segment bodies are a few slow chunks, then sends 50 `HEAD` requests for `seg0.ts`…`seg49.ts`: every one answers `200` at once, and `{ started: 50, readToEnd: 50 }`. All 50 engine reads ran to the end.

```
pnpm vitest run packages/core/test/review-poc/bugs-playback/gateway-detached-segments.test.ts
{ started: 50, readToEnd: 50 }   AssertionError: expected 50 to be +0   (with it.fails removed)
```

Not reproduced against a real engine (no load test on the shared dev engine).

## Fix direction

Answer `HEAD` on segments without a transcode (or refuse it), and cap detached reads per session and in total (past the cap, cancel the upstream as for playlists); optionally detach only when another viewer of the session asked for the same segment.

## Public-release blocker

No (it needs a valid media token), but fix it before tokens are handed to people the operator doesn't trust.
