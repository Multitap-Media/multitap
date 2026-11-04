---
type: Decision
title: "An incremental source list answers 202 after the item's meta lookup"
description: "Maintainer decision 2026-11-04: GET /v1/streams/…?incremental=true answers 202 only once the item's meta is known, so SourceListStarted.addons is an exact count of the streams.partial events to expect; answering first would make that count a guess."
tags: [core, api, selection, events, decision]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T10:57:40Z" }
code_refs:
  - "packages/core/src/selection/source-list.ts"
  - "packages/core/src/http/routes/browse.ts"
  - "packages/api/src/browse.ts"
status: stable
---

**Decision (maintainer, 2026-11-04).** With `incremental=true`, `GET /v1/streams/:type/:videoId` answers `202` once the item's meta lookup is done, not before it. The addons are still asked at once.

**Why.** `SourceListStarted.addons` is a required count of the `streams.partial` events the client will get, the last with `remaining: 0`. One of those parts is synthetic: the streams the meta item carries itself, or the stream derived from a `yt_id:` id. Only the meta lookup says whether that part exists, so answering first would turn the count into a guess, or need a breaking change to the `202` body. A client that relies on the count to know when the list is complete keeps that guarantee.

**The cost.** The `202` waits for the slowest meta addon, up to its timeout (5 s by default). The streams addons don't wait: they're asked at once, and an answer that arrives before the `202` is queued and sent as its `streams.partial` event, so nothing is lost.

**Considered and declined.** Answering `202` first and sending the count in the first event. That was raised by the November 2026 review as a latency improvement, but it changes what `addons` means in the published `/v1` contract.

Related: [[architecture/core-events-sse]], [[concept/addon-aggregation]], [[core-review/bugs-library-incremental-partials]].
