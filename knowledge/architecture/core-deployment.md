---
type: Architecture
title: "Multitap deployment: two listeners, CORS and TLS, no proxy required"
description: "Multitap listens on 8080 for /v1 and 8081 for /media, each private or public; a CORS allowlist, optional built-in TLS and absolute media URLs, so a reverse proxy is one option, never a requirement."
tags: [core, deployment, tls, cors, architecture]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
code_refs:
  - "Dockerfile"
  - "packages/core/src/http/listen.ts"
  - "packages/core/src/http/cors.ts"
status: stable
---

Multitap runs as a Node process or from its container image (`Dockerfile`, published as `ghcr.io/multitap-media/multitap`), separately from the clients that use it. Running them apart is what keeps Multitap standalone.

Multitap listens on two ports: `8080` for `/v1` and `8081` for `/media`. Each can be private or public: a typical setup keeps `/v1` on a private network next to its clients and serves `/media` publicly on its own host name. An operator can expose one without the other ([[architecture/network-and-deployment-exposure]]). Multitap doesn't depend on how it's reached:

- **CORS:** `MULTITAP_CORS_ORIGINS` lists the browser origins allowed to call it (a client's origin). Exact origins, no wildcard by default.
- **TLS:** terminate it in front of Multitap or in Multitap itself with `MULTITAP_TLS_CERT_FILE`/`MULTITAP_TLS_KEY_FILE` (reloaded on `SIGHUP`). This is deliberately basic; for certificates that renew, terminate TLS in a proxy or renew with an external tool. Multitap has no ACME client.
- **Path routing is not required.** Same-host path routing still works if an operator prefers it, because Multitap returns absolute media URLs from `MULTITAP_MEDIA_PUBLIC_BASE`.

The media path is browser → (optional proxy) → Multitap → engine. A client that coordinates viewers (sync, chat) is not in it, so restarting such a client doesn't interrupt playback.

The decision that nothing assumes a reverse proxy (2026-10-06) is [[decision/no-reverse-proxy-dependency]]. The settings are in [[architecture/configuration]].
