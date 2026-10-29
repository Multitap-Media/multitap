---
type: Architecture
title: "Network exposure: listeners, binds, proxies and the engine"
description: "What may face which network in a Multitap deployment: the media listener may face the internet, the /v1 API stays private or uses TLS (with a startup warning otherwise), and the engine is reachable from Multitap only."
tags: [architecture, network, deployment, security]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
code_refs:
  - "packages/core/src/index.ts"
  - "packages/core/src/http/listen.ts"
---

Multitap has two listeners ([[architecture/core-deployment]]):

- **Media** (`MULTITAP_MEDIA_PORT`, default 8081) may face the internet. Every request carries a media token for one session, and the listener serves nothing else ([[architecture/media-gateway]]).
- **API** (`MULTITAP_API_PORT`, default 8080) carries an API key on every request, so it stays on a private network or uses TLS, Multitap's own or a proxy's. Without a key it answers `404` like an unknown path ([[architecture/security-trust-domains]]).

**The plain-HTTP warning.** At startup Multitap logs a warning when the API listens on a non-loopback address (`MULTITAP_API_BIND`, default every interface) without TLS. The default bind stays, since a container needs it; in Docker the warning is expected as long as the API port isn't published, and the Dockerfile's example publishes it on loopback only.

**The engine** has no authentication ([[architecture/engine-security-posture]]). Run it where only Multitap can reach it: on the same host or a private network, with its port closed to everything else by a firewall. Torrent traffic leaves from the engine's address.

**Proxies are optional.** Multitap answers CORS from an allowlist of origins, terminates TLS itself if asked, and builds public media URLs from configuration (`MULTITAP_MEDIA_PUBLIC_BASE`), so it works with no reverse proxy ([[decision/no-reverse-proxy-dependency]]). A proxy's security headers (a `connect-src` CSP, for example) can block a browser player that loads media from another origin.

Related: [[architecture/configuration]], [[architecture/secrets-policy]].
