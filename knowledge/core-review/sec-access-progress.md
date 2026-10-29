---
type: Process
title: "Core review: sec-access progress"
description: "Progress, coverage, low findings and links to medium+ findings for the sec-access area (keys, scopes, media tokens, gateway, listeners, backups, CLI, logs, Docker) of the core adversarial review."
tags: [core, review, security, sec-access]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-20T13:08:13Z" }
status: draft
---

Area `sec-access` of the [core adversarial review](charter.md). Started and finished 2026-10-20.

## Status

Done. 0 critical, 0 high, 2 medium, 7 low, 6 info. Access control in core is solid: no route reachable with less than its scope, no auth bypass, token verification sound, logs and responses free of secrets at `info`. The two medium findings are a revocation gap and an unsafe default; both were fixed on 2026-10-25.

PoC tests: `packages/core/test/review-poc/sec-access/access.test.ts` (`pnpm vitest run packages/core/test/review-poc/sec-access`: 4 passing property tests, 3 `it.fails` bug demonstrations; each `it.fails` was also run as `it` to check it fails on its final assertion, not on setup). Since 2026-10-25 the two medium PoCs are normal tests in `packages/core/test/events.test.ts` and `packages/core/test/cors-tls.test.ts`, so the file keeps 1 `it.fails` (L1).

## Findings (medium and above)

| Severity | Finding | Verdict |
|---|---|---|
| medium | [An open /v1/events stream keeps delivering after its API key is revoked](sec-access-sse-outlives-key-revocation.md) | confirmed; fixed 2026-10-25 |
| medium | [The /v1 listener binds every interface over plain HTTP by default, with no warning](sec-access-api-listener-public-default.md) | confirmed; fixed 2026-10-25 (a startup warning) |

## Checked

- **API keys** (`auth/keys.ts`, `auth/middleware.ts`): 32 random bytes base64url, SHA-256 stored, lookup by hash plus `timingSafeEqual`, format check before any DB work, revoked keys rejected, `last_used` throttled. Missing, malformed, unknown and revoked keys all get the unknown-route `404`; wrong scope `403`. `admin` implies `client` and `metrics`; `metrics` implies nothing.
- **Scope on every route**: walked `http/app.ts` and every `http/routes/*.ts`. Scope comes from path middleware (`/v1/*` client, `/v1/admin/*` admin, `/metrics` metrics, `/openapi.json` client); every admin-only operation (keys, addons, engines, ranking, backups) is under `/v1/admin`. PoC: a client key gets `403` on every documented `/v1/admin` operation and `/metrics`; a metrics key `403` on every `/v1` operation and the document; no key `404` everywhere but `/healthz`; path tricks (double slashes, `%61dmin`, `%2f`, trailing slash, case, dot segments, `;`, `%00`) never get past the admin middleware. Media-token minting, revocation and viewers are `client` (by design).
- **Media tokens** (`gateway/tokens.ts`, `routes/media-tokens.ts`): HS256 pinned through `jose`, `exp` required, claims shape-checked, length and compact-form check before crypto, previous secret for verification only, secret ≥ 32 bytes enforced in config (file and env), epoch and subject denylist checked after the signature cache, revocations persisted and reloaded, TTL capped by `MEDIA_TOKEN_MAX_TTL_MS`, `revoke-all` reserved as a subject. Existing `gateway.test.ts` covers forgery, expiry, rotation and restart.
- **Gateway** (`gateway/app.ts`): only `GET`/`HEAD` on `/media/{token}/{file}`; anchored file allowlist (no traversal, no engine API); token before any engine call; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`; CORS from the exact-origin allowlist, no credentials; logs name session and subject, never the path (path only at `debug`).
- **Listeners, CORS, TLS** (`http/listen.ts`, `http/cors.ts`, `config.ts`, `index.ts`): exact-origin CORS, `Vary: Origin`, never `Allow-Credentials`; TLS pair validated at startup and on `SIGHUP`; ports must differ.
- **Backups and dev routes**: backup ids are anchored patterns (no traversal), files 0600 in a 0700 directory, admin only, no restore route; `/dev` is a fixed file map served only with `NODE_ENV=development` (default `production`).
- **Logs** (`log.ts`): key-name redaction to depth 6 at `info`+, warning at `debug`/`trace`; error messages across addon (`packages/addon-protocol/src/errors.ts`), engine and backup code name hosts only; engine error text is filtered (`safeEngineText`) and stripped of the proxy password before logging. No template-literal log messages with secrets found.
- **Responses** (subagent sweep of every route, schema, event payload and problem text): manifest URLs, raw streams, stream and subtitle URLs and proxy passwords never reach a `/v1` body, header, SSE event, problem detail or metrics label; validation errors never echo input. Exceptions listed below (L5, I3).
- **CLI** (`cli.ts`): key printed once to stdout, logs to stderr, proxy password only from a file. **Dockerfile**: allowlist build context (no data, `.env`, tests), non-root `node` user, code owned by root, only `/data` writable, no secrets in layers.

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| L1 | low | security | `gateway/tokens.ts:115-134`, `routes/media-tokens.ts:263-276` | Mint/revoke race: the route checks the denylist, then mints asynchronously; a revoke landing in between sets its `until` from tokens minted so far, so the new (say 8 h) token is refused only until the old token's expiry and then works again. Confirmed (`it.fails` "mint/revoke race"). **Fixed 2026-10-26 (0.2.0):** a mint for a subject that is revoked by then extends the revocation to the new token's expiry (persisted), and a revocation is denylisted before its database write, so a mint finishing meanwhile sees it; tests in `packages/core/test/token-revocation-race.test.ts`. |
| L2 | low | security | `gateway/tokens.ts:181-185` | A subject revoked in a later process gets `until = start + MEDIA_TOKEN_MAX_TTL_MS` (current config); tokens minted by an earlier process under a larger max TTL outlive the revocation. Needs the operator to lower the max between restarts. Plausible. |
| L3 | low | security | `db/index.ts:30-38`, `log.ts:85-99` | The live database (manifest URLs, proxy passwords, raw streams, key hashes) and `LOG_DIR` files are created with the process umask (typically 0644 on Linux), while backups get 0600/0700. Matters on shared bare-metal hosts only; the image runs as `node` with `/data` owned by it. Plausible (not tested on Linux). |
| L4 | low | security | `auth/keys.ts:104-117`, `routes/api-keys.ts` | Revoking an API key does not revoke the media tokens it minted, and an admin key may revoke the last admin key (CLI still recovers). Expected, but undocumented (the media-token part is in `SECURITY.md` since 2026-10-25). |
| L5 | low | security | `packages/api/src/engines.ts:46-50`, `engines/index.ts:65-75,117-163` | An engine `address` with userinfo (a user name and password before the host) is stored and echoed back on every admin engine GET/PUT; it is only refused later, when the LAN transport uses it (`lan-transport.ts:57-59`). Admin-only, echoing what the admin typed. Plausible (subagent read). |
| L6 | low | security | `addons/meta-view.ts:34-45` | `embedsAddonUrl` decodes a `stremio://` link once, so a double-encoded transport URL passes through in `MetaDetail.links`. Overlaps sec-input; plausible. |
| L7 | low | bug | `packages/core/src/http/app.ts`, `@hono/node-server` | No request body size limit on `/v1`: a key holder can send an arbitrarily large JSON body. Auth runs before the body is read, so outsiders can't. Plausible; overlaps sec-input (resource exhaustion). |
| I1 | info | design-flaw | `http/app.ts:161-174`, `test/cors-tls.test.ts:55` | CORS preflights run before auth by design, so with `CORS_ORIGINS` set anyone sending an allowed `Origin` can confirm core and list a path's methods without a key; `/healthz` also answers without a key. Fingerprinting only; the API is open source anyway. |
| I2 | info | security | `http/app.ts:137` (`hono/request-id`) | A caller-supplied `X-Request-Id` (`[\w-=]`, ≤ 255) is adopted as `reqId` in logs and echoed: an outsider can make log lines share a chosen id. |
| I3 | info | security | `routes/backups.ts:147-158` | A backup download is the whole database, secrets included (manifest URLs, proxy passwords, raw streams, engine media URLs with `api_password`). Intentional and documented in the route; [secrets policy](../architecture/secrets-policy.md) should name it as the admin exception. |
| I4 | info | security | addon views | Addon image URLs (`poster`, `background`, `logo`, `thumbnail`) pass through unchanged; some addons embed keys in them. Outside the written policy. |
| I5 | info | design-flaw | `config.ts:66-67` | One `CORS_ORIGINS` list serves both listeners: allowing a player origin on `/media` also allows it on `/v1` (harmless since `/v1` needs a Bearer key). |
| I6 | info | bug | `Dockerfile` health check | Calls `127.0.0.1`; with `API_BIND` set to another address the container reports unhealthy. Documented in the README ("leave unset in Docker"). |

Not reproduced against a real engine: nothing in this area needed the engine or real addons beyond the fakes. No the reference engine host access used.
