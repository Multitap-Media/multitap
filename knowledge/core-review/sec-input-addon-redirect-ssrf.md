---
type: Finding
title: Addon resource requests follow redirects to private and loopback hosts
description: "The addon HTTP client follows up to 20 redirects to any host with no address check, so a public addon can make core send GETs to the engine or other LAN hosts on every catalog, meta, stream or subtitle request."
tags: [core, review, security, sec-input, ssrf, addons]
generated: { by: agent/mcp, at: "2026-10-20T03:13:37Z" }
code_refs:
  - "packages/addon-protocol/src/client.ts"
  - "packages/core/src/addons/client.ts"
status: stable
---

Part of the [sec-input review](sec-input-progress.md).

- **Severity:** high. **Kind:** security.
- **Verdict:** confirmed.
- **Status:** fixed on 2026-10-20 by the [addon private-host guard](../architecture/addon-private-host-guard.md). See "Fix" below.
- **Where:** `packages/addon-protocol/src/client.ts:115-119` (`redirect: 'follow'`), `packages/addon-protocol/src/client.ts:46-59` (scheme and suffix check only); used by `packages/core/src/addons/client.ts:202` for every resource request and by manifest fetches.

## What happens

An addon installed from a public host can answer any resource request with a redirect. The client follows it (undici's default limit of 20 hops) to any address, including the engine's LAN address, `127.0.0.1` and metadata services. The response then fails JSON or schema validation, so this is mostly blind, but the GET has already happened. Core is the only machine allowed to reach the engine, and the engine has GET routes with side effects, so this is a confused-deputy path into the unauthenticated engine. It happens without any user action beyond browsing: catalogs, metas, streams and subtitle lists are fetched automatically. Each hop can point somewhere else, and the addon chooses per request.

Installing an addon whose manifest URL itself is private is an operator choice by a trusted key holder and isn't the issue; following an attacker's redirect off a public host is.

## Evidence

The PoC was `packages/core/test/review-poc/sec-input/ssrf-redirect.test.ts`; since the fix it is the normal test `packages/core/test/addon-private-hosts.test.ts`. A loopback "addon" answers every request with `302` to a loopback stand-in engine; `fetchResource` from `@multitap/addon-protocol` follows it and the stand-in records the GET. `pnpm vitest run packages/core/test/review-poc/sec-input/ssrf-redirect.test.ts` passes (guard test is `it.fails`, evidence test records one GET).

## Fix direction

Use `redirect: 'manual'` and re-validate each hop with the same guarded connect check proposed in [the subtitle finding](sec-input-subtitle-ssrf.md); refuse redirects that leave public address space unless the original addon host was itself private (an operator-installed LAN addon).

## Public-release blocker

Yes: any public addon can reach the engine's API and the LAN through core.

## Orchestrator verification (2026-10-20)

An independent verifier agreed: the finding **holds at high** and is the more serious of the two SSRFs.
- **No user action is needed.** Browsing fetches catalogs and streams on its own.
- **Engine side effects.** It brings the same side effects as the [subtitle SSRF](sec-input-subtitle-ssrf.md): one catalog response that redirects to the engine's `GET /removeAll` stops playback for every viewer.
- **Line references.** The references (`client.ts:115-119`, `:46-59`) are right.

Release blocker: **yes**.

## Fix (2026-10-20)

- **What changed.** `fetchJson` in `@multitap/addon-protocol` sends every request through `PrivateHostGuard` (`packages/addon-protocol/src/private-hosts.ts`). It follows redirects itself, one hop at a time, and every hop after the installed transport URL must reach a public address: IP literals are checked before the request, names at connect time on the address actually used. Loopback, private, link-local, CGNAT, metadata and unspecified addresses are refused, IPv4-mapped IPv6 included. A refused hop fails as `network` (`ERR_PRIVATE_HOST`).
- **What stays allowed.** The transport URL itself may be private (an admin installed it), and the operator can list LAN hosts in `ADDON_PRIVATE_ALLOW`. Design: [addon private-host guard](../architecture/addon-private-host-guard.md).
- **Tests.** The PoC's guard case now passes as a normal `it` in `packages/core/test/addon-private-hosts.test.ts` (its evidence case, which asserted the bug, was dropped). Regression tests there and in `packages/addon-protocol/test/private-hosts.test.ts` cover redirects through the addon service, the allowlist, DNS rebinding, numeric and mapped spellings of loopback, and the redirect limit.
