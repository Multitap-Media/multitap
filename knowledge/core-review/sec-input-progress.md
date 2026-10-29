---
type: Process
title: "Core review: sec-input progress"
description: "Progress, coverage, low findings and links to medium+ findings for the sec-input area (hostile addon input, SSRF, fetch limits, validation, parsing, SSE and metrics abuse) of the core adversarial review."
tags: [core, review, security, sec-input]
generated: { by: agent/mcp, at: "2026-10-20T13:14:50Z" }
status: draft
code_refs: [packages/core/src/addons/, packages/core/src/subtitles/, packages/core/src/selection/parse/, packages/core/src/engines/, packages/addon-protocol/src/]
---

Area `sec-input` of the [core adversarial review](charter.md). Started 2026-10-20.

## Status

Done (2026-10-20). Three high findings and two medium (one downgraded by the orchestrator, see the [summary](summary.md)), plus the low and info notes below. PoC tests are in `packages/core/test/review-poc/sec-input/`. Run them with `pnpm vitest run packages/core/test/review-poc/sec-input`, which gave 3 passed and 7 expected fails.

**The three highs were fixed on 2026-10-20.** Their PoCs moved into the normal suite: `packages/core/test/addon-private-hosts.test.ts` for both SSRFs and `packages/core/test/addon-text-redos.test.ts` for the ReDoS. What remains in `review-poc/sec-input/` is the engine proxy password PoC.

## Checked

- **Addon client** (`packages/addon-protocol/src/client.ts`, `packages/core/src/addons/client.ts`). It allows http(s) only. The timeout covers the body. The 8 MiB cap is checked on decompressed bytes, so a gzip bomb stops at the cap. Responses are validated with zod. Redirects are followed with no address check.
- **Subtitles** (`subtitles/index.ts`, `subtitles/convert.ts`, `gateway/subtitles.ts`). The fetch has a 5 MiB cap and a timeout but no address check. Conversion uses quadratic regexes. The gateway sends `text/vtt` with `nosniff`.
- **Engine hand-off** (`engines/resolve.ts`, `engine-module.ts`, `server-go.ts`). Covers the `url`, `proxy`, `torrent` and `youtube` plans, `proxyHeaders`, trackers, `fileMustInclude` (the engine reads it as Go RE2, which can't backtrack) and the api_password handling. I compared them with [engine security posture](../architecture/engine-security-posture.md) and [private-host allowlist](../architecture/engine-private-host-allowlist.md), and read the engine's self-origin path classifier (`internal/media/media.go`), read-only.
- **Parsing** (`selection/parse/*`). I timed every regex on long input. The third-party title parser stayed linear in a quick test (40k chars in 11 ms). A description with 20k lines takes about 0.8 s in total.
- **Validation and prototype pollution.** `JSON.parse` followed by object spread doesn't set prototypes. I found no `Object.assign` or dynamic key writes over addon data.
- **Metrics.** Label values are installed addon ids, fixed resource names and HTTP method/status, so cardinality stays bounded.
- **Events/SSE** (`events/memory-bus.ts`, `http/routes/events.ts`). The replay buffer is bounded by event count, and query parameters are bounded.

## Findings (medium and above)

- high, confirmed, **fixed 2026-10-20**: [Subtitle file fetch reaches private and loopback hosts](sec-input-subtitle-ssrf.md)
- high, confirmed, **fixed 2026-10-20**: [Addon resource requests follow redirects to private hosts](sec-input-addon-redirect-ssrf.md)
- medium (downgraded from high after verification), partly holds, fixed 2026-10-26: [Core adds the engine proxy password to addon-supplied /proxy URLs](sec-input-engine-proxy-password.md)
- high, confirmed, **fixed 2026-10-20**: [Quadratic regexes on addon text freeze core (ReDoS)](sec-input-redos.md)
- medium, plausible: [Addon-sized data is cached by count, not bytes](sec-input-unbounded-memory.md)

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| 1 | low | security | `packages/core/src/subtitles/index.ts:240-245` | The subtitle error message tells the client the upstream HTTP status, which works as a host and port probe together with the subtitle SSRF. Plausible. |
| 2 | low | security | `packages/core/src/engines/resolve.ts:47-64` | Addon tracker `sources` (and `tr=` in the mediaURL) go to the engine unchecked and uncapped. Whether the engine's tracker announces refuse private hosts is engine-side and was not checked. Plausible. |
| 3 | low | security | `packages/core/src/http/routes/browse.ts:773` | `/v1/subtitles/file` sends `text/vtt` without `X-Content-Type-Options: nosniff`, unlike the gateway. Only key holders reach it. Plausible. |
| 4 | info | design-flaw | engine `internal/media/media.go` (out of scope) | With no `STREMIO_PROXY_PASSWORD`, the engine itself accepts a self-origin `/proxy` URL as media. That makes `STREMIO_PROXY_PRIVATE_ALLOW` hosts reachable through `/hlsv2`, so the allowlists are only separate when a password is set. The [allowlist concept](../architecture/engine-private-host-allowlist.md) doesn't say so. |
| 5 | info | security | `packages/core/src/addons/` | Installing an addon whose manifest URL is private is allowed. This is fine because installers are trusted key holders. The issue is redirects, covered in the redirect finding. |
| 6 | info | security | `packages/core/src/http/routes/events.ts` | I saw no cap on concurrent SSE subscribers. This overlaps sec-access, since only key holders can subscribe. |
| 7 | info | security | `packages/addon-protocol/src/client.ts` | Good: the body cap counts decompressed bytes, the timeout spans the body, and the cap is enforced while streaming. |
