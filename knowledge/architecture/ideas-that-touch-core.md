---
type: Architecture
title: "Notes from IDEAS.md: the few ideas that touch core"
description: "How core's design leaves room for the undecided ideas that touch it: pre-roll, lobby and intermissions as separate playback sessions, Plex account linking and Plex LAN URLs behind the engine's SSRF guard, voice chat outside the gateway, and everything else belonging in clients."
tags: [ideas, undecided, pre-roll, plex, core, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:37:20Z" }
status: stable
---

Ideas for apps built on Multitap are undecided, and the parts that touch Multitap are few. They're recorded here so the core design doesn't rule them out. Anything adopted moves into the design concepts first.

- **Pre-roll, lobby and intermissions** play content that isn't from a Stremio source list (the operator's own clips, say).
  - Core keeps its rule that a session starts from a source `key` in a list ([[decision/auto-select-and-fallback]]). House content is served as an ordinary content addon, or from the engine's local addon ([[architecture/future-remote-engines]]), so core needs no new entry point.
  - Each piece of content is its own playback session. The client gives them different keys, for example `room:{id}` for the main feature and `room:{id}:preroll` for the pre-roll, and swaps tokens between them. The main session stays prepared through `retainUntil` ([[architecture/engine-retention]]), so returning from an intermission needs no re-preparation. Slide shows, countdowns and lobby music are client app content and never reach core.
- **Plex account linking** (history written back to Plex) is a later, optional client feature, like the Stremio-account sync in [[architecture/library-and-profiles]]. It is not a content source: Plex content already comes through an existing Stremio Plex addon. If that addon returns LAN URLs, the engine's SSRF guard blocks them until the private-host allowlist ([[architecture/engine-private-host-allowlist]]) names the Plex host, and those URLs carry Plex tokens, so they're secrets like debrid links ([[architecture/secrets-policy]]).
- **Voice chat** is a separate WebRTC path between members and never goes through core's media gateway.
- **Everything else** (voting, polls, reactions, landing pages, templates, avatars, notifications, Discord) belongs in clients.

Related: Future work.
