---
type: Architecture
title: "Goals and non-goals"
description: "What Multitap is for (a headless Stremio client with a remote engine that any client can use, deployable on its own) and what it deliberately leaves out (people, UI, Stremio accounts, a diverging engine fork)."
tags: [architecture, goals, scope]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-29T23:02:27Z" }
status: stable
---

## Goals

- **A standard headless Stremio client whose streaming server is remote.** Multitap knows addons, catalogs, streams, a library and playback sessions, and nothing about the apps built on it: no rooms, members, sync or logins ([[architecture/boundary-rule]]). Someone who takes the engine and Multitap only needs to build a UI.
- Browse and search content through Stremio addons (Cinemeta, YouTube, Twitch, debrid, torrent indexers, …).
- **One session, many players.** A playback session transcodes once, and every player that holds a media token for it gets the same HLS stream ([[architecture/rendition-and-bandwidth]]).
- Sources can be **prepared** (fully transcoded) ahead of time, for playback that must not stall (planned, [[architecture/engine-prepare-ahead]]).
- Watch history and progress, stored in Stremio's library format ([[architecture/library-and-profiles]]).
- **Multitap deploys on its own, with no required proxy.** It answers cross-origin requests from an allowlist of origins (CORS), can terminate TLS itself, and keeps its API and media on separate listeners so an operator can expose one without the other ([[architecture/core-deployment]], [[decision/no-reverse-proxy-dependency]]).
- **Browsers get media only.** A browser player needs a media token, never an API key, and never reaches an engine ([[architecture/security-trust-domains]]).
- **Not tied to one engine** (maintainer, 2026-10-29). Engines are registered as data, and stremio-server-go is one option: the one Multitap is developed and tested with, and so far the only one tested. Another engine has to serve the same endpoints the same way ([[architecture/engine-endpoints-core-uses]]). Remote engines are planned ([[architecture/future-remote-engines]]).

## Non-goals

- Stremio user accounts, library sync, or watch-progress sync (a later option for profiles, see [[architecture/library-and-profiles]]).
- Human sign-in or a UI. Multitap trusts API keys; people are the client's business.
- Per-viewer video quality today (one rendition per session, see [[architecture/rendition-and-bandwidth]]). An engine-side ABR ladder is planned ([[decision/abr-ladder]], [[process/build-plan]]).
- A diverging fork of stremio-server-go. Multitap works within upstream's behaviour, sends changes upstream as PRs ([[process/upstream-engine-asks]]) and detects each engine feature at runtime.

Related: [[architecture/overview]], [[architecture/core-scope]].
