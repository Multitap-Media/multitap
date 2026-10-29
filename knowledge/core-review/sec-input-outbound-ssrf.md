---
type: Finding
title: "Core's own outbound fetches have no private-host guard (subtitle URLs, addon redirects)"
description: "Subtitle file URLs and addon response redirects let a hostile addon make core GET loopback and LAN hosts, including the engine's unauthenticated control routes, which only core is supposed to reach."
tags: [core, review, security, sec-input, ssrf]
generated: { by: agent/mcp, at: "2026-10-20T03:11:49Z" }
status: deprecated
---

Part of [sec-input](sec-input-progress.md) in the [core adversarial review](charter.md).

- **Severity:** high. **Kind:** security.
- **Verdict:** confirmed.

## Where

- `packages/core/src/subtitles/index.ts:109` (`isHttpUrl` is the only check on an addon's subtitle URL) and `:230-236` (`#download`: `fetch(url, { redirect: 'follow' })`).
- `packages/addon-protocol/src/client.ts:46-59` (`parseTransportUrl`: scheme and suffix only) and `:115-119` (`fetchJson`: `redirect: 'follow'`).

## What happens

The engine refuses private, loopback and metadata hosts for addon-supplied URLs because a hostile addon could otherwise point it at the router, the NAS or Plex ([engine-security-posture](../architecture/engine-security-posture.md)). Core has no such guard for the fetches it makes itself:

1. **Subtitles.** An addon's subtitle `url` only has to be `http(s)`. When

## Orchestrator verification (2026-10-20)

**Superseded.** This is an early umbrella write-up, cut short when the worker hit a usage limit. It is fully covered by the [subtitle SSRF](sec-input-subtitle-ssrf.md) and the [addon redirect SSRF](sec-input-addon-redirect-ssrf.md).

The verifier confirmed that `packages/addon-protocol/src/client.ts:115` and `packages/core/src/subtitles/index.ts:233` are the only outbound fetches of addon-derived URLs, so neither finding leaves anything uncovered. Kept only for its history; don't count it. Both findings were fixed on 2026-10-20 by the [addon private-host guard](../architecture/addon-private-host-guard.md).
