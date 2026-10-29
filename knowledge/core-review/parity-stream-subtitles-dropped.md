---
type: Finding
title: "A stream's own subtitles are parsed and then dropped"
description: "The addon protocol lets a stream carry its own subtitles (stream.subtitles), which Stremio's player adds as tracks; core parses them but neither the source list, the subtitle list nor a session's subtitles ever offer them."
tags: [core, review, parity, subtitles, streams]
generated: { by: agent/mcp, at: "2026-10-20T11:55:00Z" }
code_refs:
  - "packages/addon-protocol/src/stream.ts"
  - "packages/core/src/selection/candidates.ts"
  - "packages/core/src/gateway/subtitles.ts"
status: draft
---

Part of the [parity review](parity-progress.md).

- **Severity:** medium. **Kind:** gap.
- **Verdict:** confirmed (PoC test).
- **Where:**
  - `packages/addon-protocol/src/stream.ts:128` (`subtitles` parsed onto every stream)
  - `packages/core/src/selection/candidates.ts:119` (`toCandidate` carries no subtitles)
  - `packages/core/src/gateway/subtitles.ts:57` (a session's subtitles are the subtitles addons' list for the video only)

## What happens

The SDK's stream object has `subtitles`: "array of Subtitle objects … representing subtitles for this stream" (`stremio-addon-sdk/docs/api/responses/stream.md`). Addons that serve one specific file (HTTP or debrid sources, local or library addons) use it to ship that file's matching subtitles. Stremio's player adds them as extra tracks for that stream.

Core parses `stream.subtitles` and then never uses it: the candidate has no subtitles, `GET /v1/subtitles/{type}/{videoId}` asks subtitles addons only, and a session's `/v1/sessions/{id}/subtitles` is that same list. Since raw streams stay in core, a client has no way to get them.

## Evidence

`pnpm vitest run packages/core/test/review-poc/parity`: a stream addon returns a `url` stream with one subtitle (`lang: "xyz"`); `current: stream.subtitles reach neither the source list nor the subtitle list` passes (the source list JSON has no `xyz`; the subtitle list is empty); `expected: the stream subtitle is offered for that stream` is an expected failure.

## Fix direction

Keep a played stream's `subtitles` with its stored stream and add them to the session's subtitle list (fetched, converted and served through core like addon subtitles, so their URLs stay inside), perhaps also a count on the candidate.

## Public-release blocker

No. Addon subtitles work; this loses the best-matching subtitles for some sources.
