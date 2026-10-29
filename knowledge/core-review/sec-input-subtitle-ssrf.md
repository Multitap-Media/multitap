---
type: Finding
title: Subtitle file fetch reaches private and loopback hosts (SSRF)
description: "Core fetches addon-supplied subtitle URLs and follows redirects with no private-host guard, so a hostile addon can make core read LAN hosts or the engine and hand converted bytes to media-token holders."
tags: [core, review, security, sec-input, ssrf, subtitles]
generated: { by: agent/mcp, at: "2026-10-20T03:13:37Z" }
code_refs:
  - "packages/core/src/subtitles/index.ts"
  - "packages/core/src/gateway/subtitles.ts"
status: stable
---

Part of the [sec-input review](sec-input-progress.md).

- **Severity:** high. **Kind:** security.
- **Verdict:** confirmed.
- **Status:** fixed on 2026-10-20 by the [addon private-host guard](../architecture/addon-private-host-guard.md). See "Fix" below.
- **Where:** `packages/core/src/subtitles/index.ts:109-113` (only checks the scheme), `packages/core/src/subtitles/index.ts:230-236` (`fetch(url, { redirect: 'follow' })`, no address check), served through `packages/core/src/gateway/subtitles.ts` and `/v1/subtitles/file/{fileId}.vtt`.

## What happens

A subtitle entry's `url` comes straight from an addon. `SubtitleService.list` keeps it if it is http(s), and `file()` fetches it from core's own network position, following redirects to any host. Nothing refuses loopback, RFC 1918, link-local or metadata addresses, IPv6 equivalents, or a DNS name that resolves to one. Core is the one machine allowed to reach the unauthenticated engine, so an addon can aim core at the engine's LAN address or at `127.0.0.1` when they share a host, as well as at the router, a NAS or a cloud metadata service.

The fetched bytes are converted and served back: WebVTT passes through verbatim, and anything containing SRT-style timing lines is converted. The reply goes to whoever holds the session's media token (a browser, possibly a guest). Failures tell the caller the upstream HTTP status, which works as a host and port probe.

This is the threat the engine's SSRF guard exists for ([engine security posture](../architecture/engine-security-posture.md): "a hostile or compromised addon could otherwise point at the router, Plex or the NAS"). Core's own fetch path has no equivalent, so the guard is bypassed by going through core.

## Evidence

The PoC was `packages/core/test/review-poc/sec-input/ssrf-redirect.test.ts`; since the fix it is the normal test `packages/core/test/addon-private-hosts.test.ts`. A stand-in engine on `127.0.0.1` records requests; a subtitle list whose entry points at it makes `SubtitleService.file()` issue the GET. Run `pnpm vitest run packages/core/test/review-poc/sec-input/ssrf-redirect.test.ts`: the `it.fails` guard test fails as expected and the evidence test records exactly one GET to the stand-in engine.

## Fix direction

Give core one guarded outbound fetch for addon-derived URLs: resolve and check every address at connect time (an undici dispatcher with a `lookup`/connect check), refuse private, loopback, link-local and metadata ranges unless an operator allowlist names them, and re-check each redirect hop. Use it for subtitles and addon resources alike.

## Public-release blocker

Yes: any installed addon can turn core into a LAN and engine proxy, which the published threat model says must not happen.

## Orchestrator verification (2026-10-20)

An independent verifier agreed: the finding **holds at high**. Its corrections:
- **Damage to the engine was missed.** The engine's Host check lets IP literals through, and its cross-site gate relies on `Sec-Fetch-Site`, which Node's fetch never sends. A subtitle URL can therefore make core run engine control GETs: `/removeAll` (stops every torrent for every viewer), `/<infoHash>/remove`, and `/<infoHash>/create` (joins a swarm nobody picked). `/record` and `/proxy` stay protected by the password or by the engine's own SSRF guard. The PoC shows `GET /removeAll` arriving.
- **No redirect is needed.** The addon lists the private URL directly.
- **"Read LAN hosts" overstates it.** Bytes come back only when they parse as WebVTT or SRT, and they go to the token holder, not the addon, so in practice this is a blind GET.
- **The status-code probe is narrower than stated.** Only API-key holders see the upstream status (`browse.ts:767`). Media-token holders get a bare 502.

Release blocker: **yes**. The same address check fixes both this and the [addon redirect finding](sec-input-addon-redirect-ssrf.md).

## Fix (2026-10-20)

- **What changed.** `SubtitleService` fetches through the same `PrivateHostGuard` as addon requests, with every hop guarded, the first included, since the URL is the addon's. Core passes the guard built from `ADDON_PRIVATE_ALLOW`; without one the service uses the package default, which refuses every private host. A refused file is a `network` failure, so it reveals no upstream status.
- **What stays allowed.** Subtitle files on a LAN host the operator lists in `ADDON_PRIVATE_ALLOW`. Design: [addon private-host guard](../architecture/addon-private-host-guard.md).
- **Tests.** The PoC's guard case passes as a normal `it` in `packages/core/test/addon-private-hosts.test.ts`, with an allowlisted case beside it. The browse, contract and stack tests, whose fake addons serve subtitles from loopback, now list `127.0.0.1`.
