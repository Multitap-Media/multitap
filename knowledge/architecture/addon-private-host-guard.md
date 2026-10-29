---
type: Architecture
title: Addon private-host guard (MULTITAP_ADDON_PRIVATE_ALLOW)
description: "How core keeps addon-chosen URLs off the engine and the LAN: every hop an addon controls (addon redirects, subtitle files) must reach a public address, checked on the literal and at connect time, unless the operator's MULTITAP_ADDON_PRIVATE_ALLOW lists it."
tags: [core, addons, subtitles, ssrf, allowlist, security]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-20T17:23:59Z" }
code_refs:
  - "packages/addon-protocol/src/private-hosts.ts"
  - "packages/addon-protocol/src/client.ts"
  - "packages/core/src/subtitles/index.ts"
  - "packages/core/src/addons/"
status: stable
---

Source of truth for core's own SSRF guard. It is core's counterpart to the engine's guard ([[architecture/engine-security-posture]], [[architecture/engine-private-host-allowlist]]): core is the one machine allowed to reach the unauthenticated engine, so an addon must not be able to aim core's requests at it. Added on 2026-10-20 for the core review's two SSRF blockers ([[core-review/sec-input-addon-redirect-ssrf]], [[core-review/sec-input-subtitle-ssrf]]).

## What is guarded

Only the hops an addon controls:

- **Addon requests** (manifest and resources, `@multitap/addon-protocol`'s `fetchJson`). The first hop goes to the installed transport URL, which an admin chose, so it is trusted: installing an addon from a private manifest URL stays allowed. Every redirect after it is the addon's choice and is guarded.
- **Subtitle files** (`SubtitleService`). The URL itself comes from the addon's response, so every hop is guarded, the first included.
- **`proxyHeaders` targets** (the engine module, since 0.2.0). Core doesn't fetch these: it hands the engine a `/proxy/stream` URL with the proxy password, so before it does, the target must pass the guard (`allowsUrl`: an IP literal directly, a name by resolving it; a name that doesn't resolve is left to the engine's own dial-time check). Otherwise a target listed only in the engine's `STREMIO_PROXY_PRIVATE_ALLOW` would become reachable through the media routes ([[core-review/sec-input-engine-proxy-password]]). An addon's plain `url` stream on loopback or on the engine's own host is refused outright.

Nothing else core fetches is addon-chosen: engine requests go to the engine's configured address through their own transport, which doesn't follow redirects.

## How

One class, `PrivateHostGuard` in `packages/addon-protocol/src/private-hosts.ts`, used by both sites. Core builds one from `MULTITAP_ADDON_PRIVATE_ALLOW` in `AddonService` and hands it to the subtitle service; without one, the package's default guard (no allowlist) applies, so the safe behaviour doesn't depend on wiring.

- **Redirects are followed by the guard,** one hop at a time (`redirect: 'manual'` underneath), at most 20, http(s) only. `authorization` and `cookie` are dropped when the origin changes.
- **An IP-literal host is checked before the request.** The URL parser has already normalized `2130706433`, `0x7f.1` and `[::ffff:127.0.0.1]`; IPv4-mapped IPv6 is read as its IPv4 address.
- **A host name is checked at connect time,** on the addresses the connection actually uses: guarded hops go through an undici dispatcher whose `lookup` refuses a name if any of its addresses is refused. There is no separate pre-check, so DNS rebinding has no window between check and use.
- **Refused:** `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local, cloud metadata), `172.16/12`, `192.0.0/24`, the documentation ranges, `192.168/16`, `198.18/15`, multicast and `240/4`; `::/96` (unspecified, loopback, IPv4-compatible), `64:ff9b:1::/48`, `100::/64`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`; NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are judged by the IPv4 address they embed.
- **A refused hop fails like an unreachable host:** the addon call is `network` (cause code `ERR_PRIVATE_HOST`, which counts towards the addon's circuit breaker), and the subtitle file is a `network` failure (a bare 502), so a refusal gives no status code to probe with.

## The operator's allowlist

`MULTITAP_ADDON_PRIVATE_ALLOW` (comma-separated, default empty) names what guarded hops may reach although it is private, for LAN addons that redirect within the LAN and for subtitle files on a LAN host. Like the engine's allowlists:

- Entries are IPs, CIDRs (`10.0.0.0/24`, `fd00::/8`) or host names (`nas.lan`). A host name entry lets that name reach whatever private address it resolves to; IP and CIDR entries match the resolved address.
- Only listed entries are exempt; everything else private stays blocked.
- A metadata address (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`) is exempt only when listed exactly, never through a CIDR or a host name.
- An invalid entry stops core at startup.

One setting covers both sites: both are core's own fetches with the same trust, unlike the engine's `/proxy` and media routes, which differ in gating.

## What it doesn't cover

- **The addon's own host.** The trusted first hop goes to whatever the transport URL's name resolves to. An addon whose owner re-points its own DNS at a LAN address can reach that address on core's fixed resource paths under the installed path (`…/stream/movie/tt….json`), with no redirect and no path of its choosing. That is the admin's choice of host, not something the addon response can steer.
- **The engine's own fetches** of stream URLs: the engine's guard handles those ([[architecture/engine-security-posture]]).

Related: [[concept/addon-aggregation]], [[architecture/configuration]], [[architecture/security-trust-domains]].
