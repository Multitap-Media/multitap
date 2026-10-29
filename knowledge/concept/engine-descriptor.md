---
type: Component
title: Engine descriptor and capabilities in core
description: "How core describes an engine: transport, address, capability flags (hwaccel, live and prepared heights, tonemap, sessionOverrides, concurrency, defaultBitrate), set via the admin API and gated at runtime."
tags: [core, engine, capabilities, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/registry.ts"
  - "packages/api/src/engines.ts"
status: stable
---

Source of truth for the engine descriptor 

```ts
EngineDescriptor {
  id: string                    // 'home', later 'alex-pc', …
  name: string
  transport: 'lan' | 'tunnel'   // okf:architecture/engine-transport-and-health, okf:architecture/future-remote-engines
  address: string | null        // lan: 'http://winbox.lan:11470'; null = not reachable yet
  capabilities: {
    hwaccel: 'qsv' | 'nvenc' | 'vaapi' | 'none'
    liveMaxHeight: number       // home: 1080
    preparedMaxHeight: number   // home: 2160
    tonemap: boolean            // home: true (#27, mobius)
    sessionOverrides: boolean   // home: true (#25 with its gate on; okf:architecture/rendition-and-bandwidth)
    liveConcurrency: number     // home: 2 (phase 0; 1080p on software decode)
    prepareConcurrency: number  // home: 1
    defaultBitrate?: number     // the engine's STREMIO_TRANSCODE_VIDEO_BITRATE, bits/s; caps derived bitrates (okf:architecture/rendition-and-bandwidth)
  }
  localAddon?: boolean          // engine serves local content (okf:architecture/future-remote-engines)
  proxyPassword?: string | null // write-only: STREMIO_PROXY_PASSWORD (okf:architecture/secrets-policy); in PUT bodies only
  online?: boolean              // from health checks (okf:architecture/engine-transport-and-health); in responses only
  lastSeen?: string | null      // last successful health check; in responses only
  proxyPasswordSet?: boolean    // core holds a proxy password; in responses only
}
```

Capabilities are **configured through core's admin API** for now. A future remote-engine helper could report them itself. Core seeds **no engine** (until 2026-10-20 it seeded `home` with the capabilities above and no address, which made a fresh install claim the maintainer's hardware). The operator adds one with `PUT /v1/admin/engines/{id}`; until then source lists and sessions answer `400` naming that route, and core warns at startup. A request without `engine` uses `SELECTION_DEFAULT_ENGINE`, else the only engine there is. The maintainer's deployment adds `home` with the values above (Deploying core on the docker host). A `lan` engine without an address fails its health check and counts as offline. Changing an engine's address or transport resets its health to unknown until the next check, so a replaced engine isn't refused as offline.

**Runtime detection.** Core detects engine features at runtime (for example `DELETE` support, the `sessionOverrides` gate, the future `ladder`) and falls back to doing the work itself ([[architecture/engine-endpoints-core-uses]], Planned engine changes).

Related: [[architecture/playback-session]], Reference engine hardware and measured performance.
