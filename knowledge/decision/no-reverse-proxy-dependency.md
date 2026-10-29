---
type: Decision
title: "Nothing assumes a reverse proxy"
description: "Multitap must work with no reverse proxy in front: built-in TLS, a CORS allowlist and public media URLs from configuration; a proxy (Traefik, Caddy, nginx or any other) is an optional variant, never a dependency."
tags: [decision, deployment, security, proxy]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
---

**Decision (2026-10-06).** Nothing assumes a reverse proxy. There may be Traefik, Caddy, nginx, httpd or nothing in front of Multitap.

- **TLS:** optional and built in (`MULTITAP_TLS_CERT_FILE`/`MULTITAP_TLS_KEY_FILE`, `SIGHUP` reload on Linux, no ACME), or terminated in front.
- **CORS** from `MULTITAP_CORS_ORIGINS` (exact origins, no wildcard), and **absolute media URLs** from `MULTITAP_MEDIA_PUBLIC_BASE`, never from forwarded headers. Path routing is never required ([[architecture/core-deployment]]).
- **Its own protections:** API keys on every `/v1` request, media tokens on every media request, and the same `404` for a missing key as for an unknown path. Nothing depends on a proxy's allowlists, rate limits or headers ([[architecture/security-trust-domains]]).
- **Publishing:** the baseline is a host port. A proxy is one documented variant ([[architecture/network-and-deployment-exposure]]).

The same rule applies to the clients built on Multitap: none of them should need a proxy either.

Related: [[architecture/overview]].
