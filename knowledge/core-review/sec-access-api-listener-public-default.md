---
type: Finding
title: "Finding: the /v1 listener binds every interface over plain HTTP by default, with no warning"
description: "Unset API_BIND means all interfaces and unset TLS means plain HTTP, so a bare `node dist/index.js` (or a `-p 8080:8080` publish as the Dockerfile's own header suggests) puts the admin-capable API on the network in cleartext; core logs no warning."
tags: [core, review, security, sec-access, deployment, defaults]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-20T03:14:11Z" }
code_refs:
  - "packages/core/src/config.ts"
  - "packages/core/src/http/listen.ts"
  - "packages/core/src/index.ts"
  - "Dockerfile"
status: draft
---

Area: [sec-access](sec-access-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw (unsafe default).
- **Verdict:** confirmed (PoC test).
- **Status:** fixed 2026-10-25 with the warning, the fix direction's second option (see [Fix](#fix)).

## Where

- `packages/core/src/config.ts:405` and `:603`: `API_BIND` unset becomes `apiBind: null`, "all interfaces, Node's default".
- `packages/core/src/http/listen.ts:48`: `null` binds every interface.
- `packages/core/src/index.ts:203-220`: the startup log names the bind and TLS state but warns only about CORS without `MEDIA_PUBLIC_BASE`; nothing warns when the API is on a non-loopback address without TLS.
- `Dockerfile:5`: the header's example is `docker run … -p 8080:8080`, which publishes the API on every host interface (the README's example, `-p 127.0.0.1:8080:8080`, is the safe one).

## What happens

An operator following the threat model's "not an expert" profile runs core outside a compose file that keeps 8080 unpublished. With no configuration, `/v1`, `/metrics` and `/openapi.json` answer on `0.0.0.0`/`::` over plain HTTP. API keys are full credentials (an `admin` key reads backups with every manifest URL and proxy password, and installs addons), and every request carries one in cleartext. The `404`-without-a-key rule hides the API from casual scanning, and keys are 256-bit, so this is not an open door; but anyone on the path (shared Wi-Fi, a VPS provider network, a LAN) can lift a key, and the operator gets no signal that the setup is unsafe. The README does say "keep the API listener private", but nothing in the running program does.

## Evidence

`packages/core/test/review-poc/sec-access/access.test.ts`, test "BUG sec-access-api-listener-public-default" (`it.fails`): `loadConfig({})` gives `tls: null`, and `listen(…, config.apiBind)` binds `::`.

```
pnpm vitest run packages/core/test/review-poc/sec-access
# with it.fails switched to it:
AssertionError: expected [ '127.0.0.1', '::1' ] to include '::'
```

## Fix direction

Default `API_BIND` to loopback in code and set `API_BIND=0.0.0.0` explicitly in the image (where the docker network is the boundary), or at least log a startup warning when the API listener is on a non-loopback address without TLS; fix the Dockerfile header's example to `-p 127.0.0.1:8080:8080`.

## Fix

`API_BIND` keeps its default (every interface), since a container must listen on its network interfaces. Instead, after the listeners bind, `startCore` (`packages/core/src/index.ts`) checks the address the API listener actually got (`isLoopbackAddress` in `http/listen.ts`: `127.0.0.0/8`, `::1`, IPv4-mapped `127.x`) and, without TLS, logs a `warn` that the `/v1` API listens on every interface (or that address) over plain HTTP, that keys travel in cleartext, and the three ways out: `API_BIND=127.0.0.1`, built-in TLS, or a port only trusted hosts reach. The media listener is not checked: it is meant to be public.

In Docker the warning shows on every start over plain HTTP; the README says it is expected there while 8080 isn't published. The Dockerfile header's example now publishes `-p 127.0.0.1:8080:8080`.

Tests: the PoC now asserts the warning and moved into `packages/core/test/cors-tls.test.ts` (warned with no configuration and with `API_BIND=0.0.0.0`; not with `API_BIND=127.0.0.1`, nor with built-in TLS on every interface), plus a unit test of `isLoopbackAddress`.

## Public-release blocker

No: the documented deployments are safe and keys stay unguessable; but it is the first thing a public user will hit, and a warning is a one-line fix.
