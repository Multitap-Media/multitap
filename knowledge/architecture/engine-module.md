---
type: Component
title: "Core engine module: interface and responsibilities"
description: "The only core code that knows stream internals and engine APIs: the EngineModule interface (prepare, status, release, fetchMedia), the EngineHandle, and how phase 2 built it. Transport, preparation, lifecycle, ahead-preparation and retention are in their own concepts."
tags: [core, engine, module, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth for the engine module's interface  The rest of the engine-module design is split: transport and health [[architecture/engine-transport-and-health]]; preparing a stream, unplayable reasons and the resolution matrix [[architecture/engine-prepare-stream]]; lifecycle during playback and admission [[architecture/engine-session-lifecycle]]; preparing ahead [[architecture/engine-prepare-ahead]]; retention [[architecture/engine-retention]].

Turns a chosen `Stream` into a playable HLS session on an engine. It knows
nothing about playback sessions beyond an opaque key, and nothing about how the
stream was chosen. It's the only code that knows Stream internals and engine
APIs, so new stream types or engine features are changes to this module only.

```ts
interface EngineModule {
  prepare(req: {
    engineId: string
    sessionKey: string             // the playback session id
    stream: StremioStream          // raw, exactly as the addon returned it
    mode: 'play' | 'full'          // 'full' = transcode every segment (okf:architecture/engine-prepare-ahead)
    quality?: { maxHeight?, bitrate? }   // already capped by the caller (okf:architecture/rendition-and-bandwidth)
    onStatus?: (status: EngineStatus) => void   // progress while preparing
    signal?: AbortSignal           // a release aborts a prepare in flight
  }): Promise<{ ok: true, handle: EngineHandle, status: EngineStatus }
            | { ok: false, reason: UnplayableReason, retryable: boolean }>

  status(handle: EngineHandle): EngineStatus
  // { phase: 'metadata'|'probing'|'ready'|'preparing'|'prepared'|'failed',
  //   peers?, downloadSpeed?, preparedPct?, info?: { height, width, hdr, codec, durationSec } }

  release(handle: EngineHandle): Promise<void>   // DELETE /hlsv2/{id} (#24); no-op on an engine without it (okf:architecture/engine-retention)

  fetchMedia(handle: EngineHandle, file: string, signal?: AbortSignal): Promise<Response>
  // used only by the gateway; file is master.m3u8 | playlist.m3u8 | seg12.ts | …
}
EngineHandle { engineId, sid, quality? }   // opaque outside this module; quality = what the engine applied
```

As built in phase 2 (`packages/core/src/engines/`): `prepare` rejects `mode:
'full'` (phase 4); concurrent prepares of the same session, stream and quality
share one run. `status` serves the last known status from memory and refreshes
torrent stats (peers, speed) in the background at most every 5 s; after a core
restart it knows nothing and reports `ready`. The phases produced are
`metadata`, `probing`, `ready` and `failed`. `info.hdr` stays empty in practice,
because the engine's probe doesn't report HDR ([[architecture/engine-endpoints-core-uses]]).

Related: [[concept/engine-descriptor]], [[architecture/engine-security-posture]], [[architecture/engine-endpoints-core-uses]], [[architecture/playback-session]], [[architecture/media-gateway]].
