---
type: Architecture
title: "Engine private-host allowlist (STREMIO_PROXY_PRIVATE_ALLOW, STREMIO_HLS_PRIVATE_ALLOW)"
description: "How the engine lets named LAN hosts through its SSRF guard: two separate allowlist settings for /proxy and for mediaURL, listed addresses only, resolved at connect time."
tags: [engine, ssrf, allowlist, security]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth for the private-host allowlist (migrated from the former design document; the SSRF guard itself is in [[architecture/engine-security-posture]]).

`mediaURL` and `/proxy` accept only public addresses (plus the engine's own loopback), so the engine can't read media from a NAS or another LAN host. Phase 0 had to test through a public address. Both now take a comma-separated list of hosts and CIDRs (for example `192.168.1.20,10.0.0.0/24`), empty by default, which keeps the old behaviour.

They are two settings: `STREMIO_PROXY_PRIVATE_ALLOW` for `/proxy` and `/extractor` (upstream `99c265a`), and `STREMIO_HLS_PRIVATE_ALLOW` for `mediaURL` (#49, merged 2026-10-16). They are separate because `/proxy` can be password-gated and the media routes can't, so a host listed for `/proxy` mustn't become reachable through `/hlsv2`, `/probe` or `/tracks`.

An allowlist, not a blanket switch like upstream's `STREMIO_ARCHIVE_ALLOW_PRIVATE` and `STREMIO_FTP_ALLOW_PRIVATE`:
- Only listed addresses are exempt; everything else private stays blocked. Metadata addresses (`169.254.169.254`) are exempt only if listed exactly.
- Hosts resolve at connect time, through the dial-time check, so DNS rebinding can't slip past.
- `STREMIO_HLS_PRIVATE_ALLOW` covers `validateRemoteURL`'s media callers (probe, tracks, HLS start), `validatePersistedURL` on restore, and the relay's dialer (nested playlists and redirects). It doesn't cover subtitles or `/opensubHash`.

Core has its own allowlist in the same style for the requests it makes itself on an addon's behalf (addon redirects and subtitle files): `ADDON_PRIVATE_ALLOW`, in [[architecture/addon-private-host-guard]].

Related: [[process/engine-upstream-prs]], [[architecture/engine-hls-model]].
