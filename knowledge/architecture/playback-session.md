---
type: Component
title: "Core playback session: one source per session, keyed idempotency"
description: "A playback session binds one chosen source to one engine session; its status lifecycle, idempotent creation by key, fixed delivery and source, and how media is reached."
tags: [core, sessions, playback, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/sessions/"
  - "packages/api/src/sessions.ts"
status: stable
---

Source of truth for the playback session (migrated from the former design document; statuses as built in phase 2).

```ts
PlaybackSession {
  id: string                  // 'ps_' + random; never appears in a browser URL
  key?: string                // client-chosen grouping key, e.g. 'room:abc' (see below)
  item: { type, id, videoId? }
  engineId?: string
  source: { key: string } | { auto: true }   // picked by the client, or auto-select (okf:decision/auto-select-and-fallback)
  candidates?: SourceCandidate[]             // auto-select only: the fallback order
  chosen?: string             // candidate key actually playing
  bingeGroup?: string         // the playing source's, for auto-next (okf:decision/auto-select-and-fallback)
  tracks?: { audio: MediaTrack[], subtitles: MediaTrack[] }   // from the probe, once ready
  audioTrack?: number         // index into tracks.audio to start with (audioLanguage)
  delivery: 'direct' | 'remux' | 'transcode'   // how media reaches players (okf:concept/delivery-modes)
  mode: 'play' | 'full'       // transcode only; 'full' = transcode every segment (okf:architecture/engine-prepare-ahead)
  highRes: 'off' | 'prepareOnly' | 'on'   // okf:concept/source-ranking
  quality?: { maxHeight?, bitrate? }      // what the engine applied; absent if none (okf:architecture/rendition-and-bandwidth)
  readyBy?: string            // preparation deadline (okf:architecture/engine-prepare-ahead)
  retainUntil?: string        // client-set retention floor (okf:architecture/engine-retention)
  status: 'resolving' | 'preparing' | 'ready' | 'failed' | 'released'
  failureReason?: string      // coarse, for 'failed' (okf:architecture/engine-prepare-stream)
  progress?: EngineStatus
  tokenEpoch: number          // bumping it revokes every token (okf:concept/media-tokens)
  mediaEntry: 'master.m3u8' | 'stream'   // the file a player opens under /media/{token}/
  createdAt: string
  lastAccess: string          // last media request or session read (retention, okf:architecture/engine-retention)
  releasedAt?: string
}
```

**Statuses, as built in phase 2:** `resolving` from creation until the engine work ends in `ready` or `failed`; `released` after `DELETE` or retention. `preparing` is declared for phase 4 and never produced yet. A session a previous run left `resolving` is failed with `interrupted` when core starts, since its background work died with the process.

- **One session plays one source.** Server-go binds `mediaURL` to its session id on first use, so choosing another source means creating a new playback session. With auto-select, fallback can move through several candidates inside one session while it resolves ([[decision/auto-select-and-fallback]]; [[decision/auto-select-and-fallback]]); after `ready`, the source is fixed.
- **`key` makes creation idempotent.** Creating a session with the `key`, `item`, `source`, requested `delivery` and `quality` ([[architecture/rendition-and-bandwidth]]) of an open session returns that session (`200` instead of `201`). That's how a prepared session is found again later. Without a `key`, every create makes a new session. As built: "open" means not `failed` or `released`, so retrying a failed create makes a new session; the delivery compared is the one requested (`auto` and `transcode` stay distinct); the quality compared is the request after capping ([[architecture/rendition-and-bandwidth]]); concurrent creates with one identity are serialized, so the second finds the first.
- **Creation answers at once** (as built in phase 2). `POST /v1/sessions` stores the session and returns it with `status: 'resolving'`; the engine work (torrent metadata, probe, warm start, auto-select's fallback) runs in the background. Clients follow `session.status`, `session.ready` and `session.failed` on `/v1/events?session={id}`, or poll the session. A token can be minted while it resolves; its media answers `404` until `ready`.
- **Tracks and the starting audio track** (as built). Once ready, `tracks` lists the source's audio tracks and embedded text subtitles from the engine's probe, each with its language, codec, a `default` flag (the file's) and its `index`: the master playlist's rendition order, which is the hls.js track index. Server-go can't be told which audio rendition to mark default (it marks the file's default-flagged track, else the first; [[architecture/engine-prepare-stream]]), so the create request's `audioLanguage` (else its preferred languages, else the instance default) is resolved in core to `audioTrack`, which the client selects. It's absent with fewer than two audio tracks (the audio is then muxed) or no match, and it isn't part of the identity: the media is the same, so with a shared key it reflects the creator's request.
- **Sessions aren't shared across keys.** Two clients playing the same source under different keys get two sessions and transcode it twice. That's the price of each session having its own lifecycle (R13). A client that wants sharing uses one key.
- `released` sessions stay in the table for a while so their media URLs return `410`, not `404`.
- **`delivery` is fixed per session** once it's `ready`, like the source. A client that wants another delivery (say, direct play after a transcode) creates a new session ([[concept/delivery-modes]]).

Related: [[concept/engine-descriptor]], [[concept/media-tokens]], [[architecture/rendition-and-bandwidth]], [[architecture/engine-module]], [[architecture/core-scope]].
