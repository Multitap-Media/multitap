---
type: Architecture
title: "Multitap system overview"
description: "The three pieces around Multitap: the streaming engine it drives (stremio-server-go is the one tested), Multitap itself (addons, sources, sessions, media gateway, library) and the clients built on its /v1 API, and how a playback flows between them."
tags: [architecture, overview, multitap]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-29T23:02:27Z" }
status: stable
code_refs:
  - "packages/core/src/index.ts"
  - "Dockerfile"
---

Multitap sits between Stremio addons, a transcoding engine and any number of clients and players.

- **The engine** is a separate streaming server: torrents, debrid and plain URLs, HLS transcoding, yt-dlp. Multitap isn't tied to one engine; it's developed and tested with [stremio-server-go](https://github.com/M0Rf30/stremio-server-go), used as published ([[architecture/goals-and-non-goals]]). stremio-server-go has no authentication, so only Multitap may reach it ([[architecture/engine-security-posture]]). Engines are data, not code: an admin registers them with their capabilities ([[concept/engine-descriptor]], [[architecture/engine-module]]).
- **Multitap** (`packages/core`) is a standard headless Stremio client whose streaming server is remote. It installs addons and aggregates their catalogs, metas, streams and subtitles ([[concept/addon-aggregation]]); lists and ranks sources for an engine ([[concept/source-ranking]]); runs playback sessions on an engine ([[architecture/playback-session]]); serves their media through its media gateway with revocable media tokens ([[architecture/media-gateway]], [[concept/media-tokens]]); and keeps Stremio-format profiles and libraries ([[architecture/library-and-profiles]]). Its `/v1` API is schema-first ([[architecture/core-v1-api]], [[decision/contract-first-api]]).
- **Clients** use the API with scoped API keys, and players load media with media tokens. Rooms, watch parties, accounts and devices belong to the clients ([[architecture/boundary-rule]], [[architecture/core-scope]]).

A playback: a client asks for the source list of an item, then creates a session with a picked source or with auto-select ([[decision/auto-select-and-fallback]]). Multitap prepares the stream on an engine ([[architecture/engine-prepare-stream]]), mints a media token per viewer, and each player loads the HLS playlist from Multitap's media listener, which relays the engine's segments ([[architecture/media-gateway-proxy]]). Events on `/v1/events` report the session's progress ([[architecture/core-events-sse]]).

Multitap deploys on its own, as a Node process or a container image: two listeners (API and media), optional built-in TLS, no required reverse proxy ([[architecture/core-deployment]], [[decision/no-reverse-proxy-dependency]]).

Related: [[architecture/goals-and-non-goals]], [[architecture/core-modules]]; the [project map](../project-map.md) lists every concept.
