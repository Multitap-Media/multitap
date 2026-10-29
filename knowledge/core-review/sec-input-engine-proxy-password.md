---
type: Finding
title: Core adds the engine proxy password to addon-supplied engine /proxy URLs
description: "A plain url stream pointing at the engine's own loopback /proxy/stream gets core's stored api_password appended, so a hostile addon passes the proxy password gate and reaches proxy-only allowlisted hosts through the media routes."
tags: [core, review, security, sec-input, engine, secrets]
generated: { by: agent/mcp, at: "2026-10-20T03:13:38Z" }
code_refs:
  - "packages/core/src/engines/engine-module.ts"
  - "packages/core/src/engines/server-go.ts"
  - "packages/core/src/engines/resolve.ts"
status: stable
---

Part of the [sec-input review](sec-input-progress.md).

- **Severity:** medium (downgraded from high by the orchestrator after verification). **Kind:** security.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/engines/engine-module.ts:142-144` (`withPassword`), `packages/core/src/engines/engine-module.ts:432-433` (a `url` plan's URL is used as `mediaURL` unchanged), `packages/core/src/engines/engine-module.ts:448` and the master call (`outbound(mediaURL)`), `packages/core/src/engines/server-go.ts:353-356` (`withApiPassword` matches on a string prefix only).

## What happens

`withApiPassword` appends `api_password` to any `mediaURL` that starts with `${selfBase}/proxy/stream?`, where `selfBase` is the predictable `http://127.0.0.1:<engine port>`. It is applied to every plan kind, including a plain `url` stream whose URL came from the addon. So an addon that returns `url: http://127.0.0.1:11470/proxy/stream?d=<base64 target>` gets core's secret attached and sent to the engine as the probe and master `mediaURL`. The engine accepts its own origin's `/proxy` as a relayed media URL, and `/proxy` then fetches the target with the password satisfied.

Two design properties break: `STREMIO_PROXY_PASSWORD` no longer gates `/proxy` against addons, and a host listed only in `STREMIO_PROXY_PRIVATE_ALLOW` becomes reachable through `/hlsv2`, which [the allowlist design](../architecture/engine-private-host-allowlist.md) says must not happen. The bytes go to the session's token holder.

Engine-side note (out of scope, info): with no proxy password set, the engine itself already lets a self-origin `/proxy` media URL through, so the two allowlists are only separate when a password is set. Recorded in the progress concept.

## Evidence

`packages/core/test/review-poc/sec-input/engine-proxy-password.test.ts` with the fake engine and a fake password: the evidence test asserts the probe `mediaURL` for the addon's plain `url` stream carries `api_password` equal to the stored password; the guard test is `it.fails`. `pnpm vitest run packages/core/test/review-poc/sec-input/engine-proxy-password.test.ts`: 1 passed, 1 expected fail.

## Fix direction

Add the password only to URLs core built itself (the `proxy` plan's `proxyStreamMediaURL`), not by prefix match; and refuse (`unplayable`) any addon `url` whose origin is the engine's self-origin or another loopback address.

## Public-release blocker

Yes: leaks the use of an engine secret to any addon and defeats a documented security setting.

## Orchestrator verification (2026-10-20)

An independent verifier found that this **partly holds and is medium, not high**. The prefix match at `server-go.ts:353-356` is real, but it gives an addon nothing it doesn't already have:
- Any addon `url` stream with a non-empty `behaviorHints.proxyHeaders` becomes a `proxy` plan (`resolve.ts:80-90`). Core then builds the engine `/proxy/stream?d=<addon target>&api_password=…` URL itself (`server-go.ts:340-349`), and the engine accepts its own origin's media routes as `mediaURL` (`media.go:637-660`).
- The password is never disclosed outside the core-to-engine link: not in API views and not in logs.

The real issue, reframed: **core's proxy plan merges the engine's two private-host allowlists.** It matters only when the operator sets both `STREMIO_PROXY_PASSWORD` and `STREMIO_PROXY_PRIVATE_ALLOW`.

The fix direction above is not enough on its own. Core would also have to refuse private targets in proxy plans, or limit them.

Release blocker: **no**. Document it next to the allowlist and fix it with the SSRF guard.

## Resolution (2026-10-26, 0.2.0)

Fixed, with both parts of the fix direction and the orchestrator's addition:
- The password goes only on the `/proxy/stream` URL core builds for a `proxy` plan: in `prepare`, a `url` plan's media URL is sent as it is. Stored media URLs that start with the engine's `/proxy/stream` can now only be core-built ones, so the re-sends (master self-heal, `/opensubHash`) still add it there.
- An addon `url` stream whose host is loopback (`localhost`, `127/8`, `::1`, `0.0.0.0`, `::`, mapped forms) or the engine's own address host is refused as `unsupported`.
- A `proxy` plan's target must pass core's private-host guard ([[architecture/addon-private-host-guard]]): a private host only when `MULTITAP_ADDON_PRIVATE_ALLOW` lists it, so the engine's two allowlists stay separate. A host name is resolved once at prepare; DNS rebinding after that is left to the engine's own dial-time check.

The PoC became `packages/core/test/engine-proxy-password.test.ts`.
