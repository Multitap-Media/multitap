---
type: Requirement
title: "Secrets: transit, redaction and logging policy"
description: "What core fetches from addon-supplied URLs, how manifest URLs and raw streams stay in core (and transit through the client as Secrets), backup downloads as the admin exception, no referrer on media tokens, the info-versus-debug logging rule, proxies outside core, and the client's secrets and log redaction including redactEmail."
tags: [security, secrets, logging, requirement]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:19:10Z" }
code_refs:
  - "packages/core/src/lib/secret.ts"
status: stable
---

Source of truth for this topic ((first part; the classes and the engine password are in [[architecture/secrets-classes-and-engine-password]])).

- **Core fetches URLs that addons supply**: manifests, resources and subtitle
  files. Only http(s), with timeouts and size caps. Addons are chosen by the
  operator and trusted to that extent; an addon could still point a subtitle URL
  at an internal address, so core should not run with access to anything more
  sensitive than the engine ([[architecture/network-and-deployment-exposure]]).

- Addon manifest URLs (which embed debrid and other keys) and raw `Stream`
  objects / `mediaURL`s live only in core's SQLite and memory. The client never
  stores them. The one exception is **transit**: an admin adding an addon
  sends the manifest URL from the browser through the client to core, as does an
  engine's `proxyPassword`. The client holds each as a `Secret` from parsing to
  the core call, redacts it in logs, and never stores or returns it (core's
  responses already omit both).
- They're never sent to browsers, and they're redacted in logs at `info` and
  above (below).
- **Backup downloads are the admin exception.** `GET /v1/admin/backups/{id}`
  (admin key only) returns the whole database, so it carries every secret core
  stores: manifest URLs, raw streams and engine `mediaURL`s (with the proxy
  password for proxied sources), engine proxy passwords and hashed API keys.
  That is intentional, and it is the only `/v1` response that does: a backup
  is handled like the database itself ([[architecture/core-persistence]]).
- Media tokens are bearer credentials in URL paths. Responses send
  `Referrer-Policy: no-referrer`.
- **Logging policy.** At `info` and above, core redacts secrets from its logs:
  media tokens (logged as session id + subject instead of the path), manifest
  URLs, stream URLs, `mediaURL`s and API keys. At **`debug` and `trace` it
  redacts nothing**, so an operator can see exactly what core sent and received;
  core logs a warning at startup when a debug level is on. Debug logs therefore
  contain credentials: treat them as secret and don't ship them anywhere shared.
- **Proxies are outside core.** Whether a reverse proxy in front of core logs
  request paths (and so media tokens) is the operator's policy, not something
  core can enforce. The recommendation is to drop or redact the path in the
  media host's access log.
- Core's TLS key file (when core terminates TLS) is a secret; mount it
  read-only.
- Core's own secrets: `MEDIA_TOKEN_SECRET` and the API key hashes.
- The client's secrets: its core API keys, the SMTP password when AUTH is used
  (`SMTP_PASSWORD_FILE`, used by `packages/auth`'s mailer), its TLS key when it
  terminates TLS, and later the Discord client secret. Session ids, login
  tokens, codes and break-glass tokens are stored only as hashes.
- **The client's logs** follow core's policy: redacted at `info` and above
  (cookies, `authorization`, session ids, tokens and codes, the token segment
  of `/auth/magic/…`, WebAuthn challenges, core keys, manifest URLs and engine
  passwords in transit), nothing redacted at `debug`/`trace`. **Email
  addresses** appear only through `redactEmail` (`mic***@gma***`: up to 3
  characters of the local part and of the domain, never more than
  `length - 1` of either) at `info` and above, and may appear in that form at
  every level (2026-10-06).

Related: [[architecture/secrets-classes-and-engine-password]], [[concept/media-tokens]], [[architecture/engine-security-posture]], [[decision/fixtures-redaction-rule]].
