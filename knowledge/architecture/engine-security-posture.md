---
type: Requirement
title: Engine has no auth and must be reachable only by core
description: "stremio-server-go has no authentication; it is reachable only by core on the LAN. The SSRF guard protects the LAN from addon-supplied URLs, not the engine's own endpoints."
tags: [engine, security, ssrf, requirement]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

This concept is the source of truth for the engine's security posture (migrated from the former design document; [[architecture/network-and-deployment-exposure]] covers the network side; AGENTS.md "Security reminders").

- **No authentication.** The engine exposes a proxy, torrent creation, and ffmpeg/yt-dlp shell-outs. Anything that can reach the port is fully trusted.
- **Origin allowlist** (`1a53797`): requests with a disallowed `Origin` get `403`. Core's server-side requests send no `Origin`, so they always pass. Browsers never reach an engine.
- **Bind address.** Set `BIND_ADDRESS` to the LAN IP. server-go then also starts a loopback listener on `127.0.0.1:HTTP_PORT`, so ffmpeg's self-requests keep working (`0d5f19a`).
- **The SSRF guard** (`mediaURL`, `/proxy`, nested playlists) refuses private, loopback and metadata addresses. With core in front, nobody else can call the engine's API, so the guard isn't protecting the engine's endpoints. It protects the **LAN from the URLs addons supply**: core hands an addon's stream URL to the engine, and for a `/proxy/stream` source the engine returns the fetched bytes to whoever holds the token, a guest included. A hostile or compromised addon could otherwise point at the router, Plex or the NAS. So it stays on by default. Allowing private hosts is an allowlist: name the NAS, leave the router and everything else blocked ([[architecture/engine-private-host-allowlist]]).
- **Core's own fetches are guarded too.** Core is the one machine that can reach the engine, so an addon must not be able to aim core at it: addon redirects and subtitle files go only to public addresses unless `ADDON_PRIVATE_ALLOW` lists the host ([[architecture/addon-private-host-guard]]). Without that guard, one catalog redirect or subtitle URL made core call the engine's `GET /removeAll` (the core review's two SSRF blockers, fixed 2026-10-20).
- Therefore an engine must be reachable **only by core**: firewall on the LAN, and a tunnel with a path allowlist for future remote engines ([[architecture/future-remote-engines]]).
- **`/proxy/stream`** with `STREMIO_PROXY_PASSWORD` set refuses a request without the matching `api_password` ([[architecture/secrets-policy]]). The `api_password` log redaction was fixed upstream (item 5 of issue #43).
- Addon manifest URLs, raw Stream objects and mediaURLs can carry debrid tokens; keep them out of browsers, commits, and logs at info and above.

Related: [[architecture/engine-hls-model]], [[process/engine-upstream-prs]].
