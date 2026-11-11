---
type: Decision
title: "Live HLS: core rewrites the engine's playlist and seals child URLs into the path"
description: "Choices made building live HLS on 2026-11-11, for the maintainer to confirm: core rewrites the engine's proxied playlists again so no upstream URL or proxy password reaches a player; child names are the upstream URL encrypted with a key derived from the media token secret (stateless); a live session is delivery direct with mediaEntry master.m3u8 and a new live flag; an explicit transcode request still fails with live."
tags: [core, gateway, live, hls, secrets, decision]
generated: { by: "agent/claude", at: "2026-11-11T12:00:00Z" }
code_refs:
  - "packages/core/src/engines/live.ts"
  - "packages/core/src/engines/engine-module.ts"
  - "packages/core/src/gateway/app.ts"
status: draft
---

**Status.** The maintainer asked for live HLS (2026-11-11) without settling these points; they were chosen while building and are recorded here to be confirmed or changed. All of them can change without breaking `/v1`, except the `live` field once released.

1. **Core rewrites the engine's playlist a second time.** The engine's HLS proxy answers playlists whose children are absolute engine URLs carrying the upstream URL, the addon's header parameters and, on a protected engine, `api_password`. The design said the gateway would "allow the proxy's rewritten child paths"; passing them on would hand a player the origin's tokens and the engine's password, against [[architecture/secrets-policy]] and the rule that only core reaches the engine. So core replaces every child with a name of its own ([[architecture/media-gateway]]).
2. **The name is the upstream URL, encrypted (stateless).** `live/{sealed}.{ext}` holds the child's URL under AES-256-GCM, bound to the session and to the extension, with the key derived from the media token secret. **Declined:** a per-session table from a short id to the URL. A live playlist names new segments every few seconds, so the table would need a size limit and eviction, and it would be empty after a restart of core while players still hold the old names.
3. **A live session is `delivery: 'direct'`** with `mediaEntry: 'master.m3u8'`, and says `live: true`. `direct` is what [[concept/delivery-modes]] defines as "nothing beyond fetching, or its proxy for HTTP sources". **Declined:** leaving `delivery: 'transcode'` (untrue, and a client sizing bitrate for a party would be misled), and a new `delivery` or `mediaEntry` value (a new value in a response enum breaks `/v1` clients).
4. **`delivery: 'auto'` plays live; `delivery: 'transcode'` and `mode: 'full'` still fail with `live`.** The engine can't transcode or prepare a source without a duration, and a client that asked for a transcode (a watch party sizing one rendition for everyone) should hear that it didn't get one.
5. **Every child is checked against the private-host guard** before the engine is asked, because the engine is sent there with its proxy password ([[architecture/addon-private-host-guard]]). The cost is a DNS lookup per host per minute.
6. **A playlist with anything unexpected is refused whole** (`502`): better a failed channel than an upstream URL passed through.

**Not done.** The engine's signed URLs (`POST /generate_url`, `RIVULET_PROXY_SECRET`) aren't used; core authenticates with the proxy password. Quality requests are ignored for a live session: the player picks among the origin's own variants.

Related: [[architecture/media-gateway]], [[process/phase-4-core-checklist]], [[concept/media-tokens]], [[architecture/engine-endpoints-core-uses]].
