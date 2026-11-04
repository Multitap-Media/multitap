---
type: Architecture
title: "Multitap deployment: two listeners, CORS and TLS, no proxy required"
description: "Multitap listens on 8080 for /v1 and 8081 for /media, each private or public; a CORS allowlist, optional built-in TLS and absolute media URLs, so a reverse proxy is one option, never a requirement."
tags: [core, deployment, tls, cors, architecture]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T12:00:00Z" }
code_refs:
  - "Dockerfile"
  - "packages/core/src/index.ts"
  - "packages/core/src/http/listen.ts"
  - "packages/core/src/http/cors.ts"
  - "packages/core/src/http/app.ts"
status: stable
---

Multitap runs as a Node process or from its container image (`Dockerfile`, published as `ghcr.io/multitap-media/multitap`), separately from the clients that use it. Running them apart is what keeps Multitap standalone.

Multitap listens on two ports: `8080` for `/v1` and `8081` for `/media`. Each can be private or public: a typical setup keeps `/v1` on a private network next to its clients and serves `/media` publicly on its own host name. An operator can expose one without the other ([[architecture/network-and-deployment-exposure]]). Multitap doesn't depend on how it's reached:

- **CORS:** `MULTITAP_CORS_ORIGINS` lists the browser origins allowed to call it (a client's origin). Exact origins, no wildcard by default. On `/v1` an allowed origin may send `Authorization`, `Content-Type` and `Last-Event-ID`, and may read `Allow`, `Content-Disposition`, `Retry-After`, `X-Events-Replay` and `X-Request-Id` (`Access-Control-Expose-Headers`), so a browser client sees a `405`'s methods, a backup's file name, a `503`'s retry delay, whether an event replay was complete, and the request id to quote; never credentials. On `/media` it exposes `Content-Length` and `Content-Range` ([[architecture/media-gateway-proxy]]).
- **TLS:** terminate it in front of Multitap or in Multitap itself with `MULTITAP_TLS_CERT_FILE`/`MULTITAP_TLS_KEY_FILE` (reloaded on `SIGHUP`). This is deliberately basic; for certificates that renew, terminate TLS in a proxy or renew with an external tool. Multitap has no ACME client.
- **Path routing is not required.** Same-host path routing still works if an operator prefers it, because Multitap returns absolute media URLs from `MULTITAP_MEDIA_PUBLIC_BASE`.

The media path is browser → (optional proxy) → Multitap → engine. A client that coordinates viewers (sync, chat) is not in it, so restarting such a client doesn't interrupt playback.

**Process lifecycle** (`main` in `packages/core/src/index.ts`):

- **One server per data folder.** Startup takes the data folder's lock before anything touches the database; a second core on the same folder stops with an error naming the folder ([[architecture/core-persistence]]).
- **`SIGTERM` / `SIGINT`:** graceful shutdown (event streams end, listeners close, held-back library progress is flushed, the database closes, the lock is released), then exit 0. If that takes longer than 8 s, core exits 1 anyway: below Docker's default 10 s stop grace, so core's own exit and last log lines come before Docker's `SIGKILL`. The listeners cut open responses after 5 s (`CLOSE_GRACE_MS`), which leaves the rest for flushing.
- **`SIGHUP`** is always handled, so it never kills core without a graceful shutdown: with built-in TLS it reloads the certificate files; without, it is logged and ignored. Windows has no `SIGHUP`.
- **Uncaught errors** (`uncaughtException`, `unhandledRejection`): logged as `fatal`, then the same graceful shutdown bounded to 3 s, then exit 1, so a crash still flushes progress and the log file where it can.
- **Unknown `MULTITAP_*` variables** are named in one startup warning (names only, never values) ([[architecture/configuration]]).

The decision that nothing assumes a reverse proxy (2026-10-06) is [[decision/no-reverse-proxy-dependency]]. The settings are in [[architecture/configuration]].
