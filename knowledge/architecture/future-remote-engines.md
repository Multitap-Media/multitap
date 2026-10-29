---
type: Architecture
title: "Future work: remote engines and local content"
description: "Not planned for v1: a friend's engine (helper app with an outbound tunnel, pairing code, allowed-paths-only agent, consent for torrenting, capability reporting) and the maintainer's local library on the reference engine through upstream PRs #31 and #32; the seams already in place."
tags: [future, remote-engines, tunnel, local-files, phase-5, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:37:20Z" }
status: stable
---

Source of truth for this topic  Build-plan row: phase 5 in [[process/build-plan]].

Not planned for v1, but the design leaves room for it: a friend with a strong GPU, or their own local media library, runs an engine that core can use. This is entirely core's concern; the client doesn't change.

- **Helper app for the friend:** a single install bundling stremio-server-go, ffmpeg, and a tunnel agent. The friend pastes a **pairing code** generated through core's admin API. The agent opens an **outbound** connection to core, so there's no port forwarding, and core's `tunnel` transport ([[architecture/engine-transport-and-health]]) sends engine requests over it. Tunnel options: a WebSocket request multiplexer in core, rathole/frp, or embedded Tailscale (`tsnet`).
- **Security:** the friend's server-go stays unauthenticated and bound to loopback. It's reachable only through the agent, and the agent **allows only the paths core uses** ([[architecture/engine-endpoints-core-uses]]). The pairing token is revocable.
- **Consent:** the helper must make torrenting explicit and opt-in, because swarms would see the friend's IP. It could offer a debrid/HTTP-only mode.
- **Capabilities:** the agent reports hwaccel and suggests `liveMaxHeight`/`tonemap`. The admin confirms them. Ranking and engine selection ([[concept/source-ranking]], [[decision/auto-select-and-fallback]]) then route 4K sessions to that engine automatically.
- **Local content:** the friend's `/local-addon` is consumed by core as a normal content addon through the tunnel. Its streams get `requiresEngine: <friend>`, because only that engine can read those files.
- **Media path:** viewers still only talk to core. Segments flow friend → core → viewers, which is fine given the 3 Gb link. The friend's upload carries one copy of the stream, not one per viewer.
- **Local content on the reference engine, too.** The same path serves an operator's own library on the engine host. Two upstream PRs from another contributor make server-go's local-files addon fit for it: #31 (series, with Stremio episode ids in `meta.videos` and per-episode streams; merged) and #32 (indexed files served over HTTP with byte ranges instead of `file://`; merged, and served only when `STREMIO_LOCAL_FILES_PUBLIC_URL` is set, GET/HEAD only). With both, core consumes the engine's local addon like any other content addon, its streams carry `requiresEngine`, and they go through HLS or direct play ([[concept/delivery-modes]]) like any HTTP source. Three things to get right: point `STREMIO_LOCAL_FILES_PUBLIC_URL` at the engine's LAN address (only core fetches; browsers still go through the gateway), give the engine service an account that can read the NAS share by UNC path (it can't see a mapped drive), and build the engine from a commit that has #31.
- **Seams already in place:** the engine registry, per-session engine binding, the transport interface, capabilities-based ranking, candidate engine affinity, and prepared sessions bound to their engine.

Related: [[architecture/goals-and-non-goals]], [[process/upstream-engine-asks]].
