---
type: Component
title: "Addon aggregation: routing, manifest hints, timeouts, series and subtitles"
description: "How core queries addons: routing by resource, type and idPrefixes, manifest behaviour hints and needs-configuration, streams embedded in meta, the addon User-Agent, timeouts and partial results, series and bingeGroup, and subtitle aggregation and conversion."
tags: [core, addons, aggregation, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/addons/"
  - "packages/core/src/subtitles/"
status: stable
---

Source of truth for addon aggregation 

- **Routing:** query an addon only if its manifest declares the resource, the
  type, and a matching `idPrefixes` (for example, `tt` for IMDb, `yt_id:` for
  YouTube). Catalog `extra` (search, skip, genre) is URL-encoded per the
  protocol.
- **Manifest hints:** the `Addon` view carries `behaviorHints` (`configurable`,
  `configurationRequired`, `adult`, `p2p`), a `state` and a `configurationUrl`
  (`{origin}/configure`; never the secret path). An addon with
  `configurationRequired` is installed but not queried: aggregation reports it
  with status `needs-configuration` in the addon outcomes (`AddonStatus`)
  instead of failing every call.
- **Streams embedded in meta:** a source list also includes the streams the
  meta carries for the video (`videos[].streams`; for a movie, the meta's own
  `streams`), as candidates of the addon that served the meta, ranked and keyed
  like any other (the meta addon gets its own part of the list, as the derived
  `yt_id:` stream's addon does). `trailerStreams` are not sources, as in
  stremio-core.
- **Addon requests** send `User-Agent: Multitap/<version> (+https://multitap.dev)`
  (`MULTITAP_ADDON_USER_AGENT`) with `accept: application/json`. The installed
  transport URL may be private (the admin chose it), but its redirects, and
  every hop of a subtitle file fetch, must reach a public address unless
  `MULTITAP_ADDON_PRIVATE_ALLOW` lists the host ([[architecture/addon-private-host-guard]]).
- **Addon text is bounded.** A stream's `name`, `description`, `title`,
  `behaviorHints.filename` and `bingeGroup` are cut to 4096 characters when
  the response is parsed (`STREAM_TEXT_MAX_CHARS`; real labels are a few
  hundred), so the release-name parser never sees a megabyte of addon text,
  and every regex core runs over addon text (stream labels, meta names and
  runtimes, subtitle files) is linear. Both came from the core review's ReDoS
  blocker ([[core-review/sec-input-redos]]); `packages/core/test/addon-text-redos.test.ts`
  times each pattern on a megabyte of hostile input.
- **Timeouts:** catalog/meta 5 s, streams 10 s. Return partial results rather
  than waiting on a slow addon. Stream results can also arrive incrementally as
  `streams.partial` events.
- **Series:** meta `videos[]` gives episode ids (`tt123:1:2`). Streams are
  fetched per episode. `bingeGroup` is kept for auto-next (same release group):
  as built, every candidate carries it, a ready session exposes its source's,
  and auto-select ranks it up when the request passes it back ([[decision/auto-select-and-fallback]]).
- **Subtitles:** addon subtitles are aggregated like streams. Core converts
  SRT/ASS to WebVTT (small JS converter) and serves them from `/v1/subtitles/…`.

Related: [[concept/source-ranking]], [[decision/auto-select-and-fallback]], [[architecture/core-events-sse]], [[architecture/normalized-addon-types]], [[architecture/core-subtitles-and-player-state]].
