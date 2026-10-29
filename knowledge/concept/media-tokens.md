---
type: Component
title: "Core media tokens: JWT path segments with epoch revocation"
description: "HS256 JWT media tokens in the media URL path, default 8h lifetime, per-subject and per-session revocation, the 409 rule for denylisted subjects, and the secret-rotation behaviour."
tags: [core, media-tokens, security, jwt, component]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/gateway/tokens.ts"
  - "packages/core/src/gateway/token-service.ts"
status: stable
---

Source of truth for media tokens (migrated from the former design document; the URL scheme is [[architecture/media-gateway]], see [[architecture/media-gateway]]).

- **What they are:** an HS256 JWT signed with core's `MULTITAP_MEDIA_TOKEN_SECRET` (library: `jose`), carrying `{sessionId, subject, epoch, exp}`. `subject` is an opaque string chosen by the client (the client uses the member id). Core only uses it for revocation and per-viewer telemetry. `jose` checks the signature, the pinned algorithm and `exp`; the epoch, the subject denylist and the released check are ours, and run against in-memory state. A second secret can be accepted while rotating (`MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS`: verification only, tried after the current one; core never signs with it). Tokens are about 200 characters, and the dots are fine in a path segment.
- **How they're used:** the token is a path segment, `/media/{mediaToken}/master.m3u8`, so the relative child URIs in server-go's playlists carry it with no playlist rewriting ([[architecture/media-gateway]]).
- **Lifetime:** default `8h` (`MULTITAP_MEDIA_TOKEN_TTL_MS`), long enough for a party; a mint request may ask for another `ttl`, capped at `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS` (7 days). A token that expires mid-playback breaks segment fetches, because hls.js has already resolved its URLs. Clients refresh before expiry and reload the master at the current position.
- **Revocation:** per subject or for the whole session (bump `tokenEpoch`). Releasing a session also ends its tokens. A subject's denylist entry is persisted and lasts until the latest token core minted for that subject would expire; core only knows the tokens minted since it started, so for a session older than the process (with a configured secret) the entry lasts at least until process start + `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS`. While it lasts, minting for that subject answers `409`: the client uses another subject ([[discovery/media-subject-revocation-blocks-reuse]]). A mint that races a revocation (the route checked the denylist before the revocation landed) extends the entry to the new token's expiry, and a revocation is denylisted in memory before it is written, so a token minted meanwhile never outlives it (fixed in 0.2.0). Entries live in `token_revocations` and are reloaded at startup, so a revocation survives a restart; expired ones are purged by the retention sweep. Revoking a subject that by these rules can have no live token stores nothing.
- **Minting** (`POST /v1/sessions/{id}/tokens`, as built) answers `201` with `{ token, subject, sessionId, mediaPath, mediaUrl?, exp }`: `mediaPath` is `/media/{token}/` plus the session's `mediaEntry`, and `mediaUrl` is `MULTITAP_MEDIA_PUBLIC_BASE` + `mediaPath`, present only when that's set. `ttl` is in seconds. A released session answers `410`.
- **Without a secret** core signs with a random key per process and warns: tokens then die with a restart.
- Tokens are minted only through the `/v1` API. Media is loaded cross-origin with no credentials (the token is the path), so CORS on the media listener needs no `Allow-Credentials`.
- **Who holds API keys:** the client's server does; a browser player gets only media tokens ([[architecture/security-trust-domains]]). An operator who exposes `/v1` to a browser-only client (a single-user app with CORS allowing its origin) accepts that the browser holds a `client` key.

Related: [[architecture/playback-session]], [[architecture/core-scope]].
