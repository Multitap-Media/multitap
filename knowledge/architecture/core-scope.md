---
type: Architecture
title: "Core scope: what core owns and what it never knows"
description: "Core is a standalone headless Stremio client with a remote engine; it owns addons, source lists, engines, playback sessions, media delivery and profiles, and knows nothing of rooms, members, roles or sync."
tags: [core, scope, boundary]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/"
status: stable
---

Source of truth for core's scope. The core concepts, from [[architecture/core-modules]] to [[architecture/media-gateway]], describe core. Core is standalone: nothing in them assumes a particular client.

Core is what a Stremio app would be if its streaming server ran on another machine and its UI were somebody else's. It owns:
- the addon collection, catalogs, meta, streams and subtitles
- source lists annotated for an engine, ranking, and optional auto-select ([[concept/source-ranking]])
- engines and their capabilities ([[concept/engine-descriptor]])
- **playback sessions**: a chosen source on an engine, prepared, retained and released ([[architecture/playback-session]])
- **media delivery** to any number of token holders per session ([[concept/media-tokens]], [[architecture/media-gateway]])
- **profiles** and their Stremio-format library ([[architecture/library-and-profiles]])

It doesn't know about rooms, members, roles, sync, chat, schedules, or people. A client that wants those builds them on top, as the client does ([[architecture/boundary-rule]]).

A single-user client creates one profile and mints one token per playback. A watch-party client mints a token per viewer, and a client that hands playback between devices one per device (Continuity across devices). Core behaves the same in all three cases.
