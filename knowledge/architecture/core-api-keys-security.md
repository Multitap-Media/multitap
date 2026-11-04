---
type: Requirement
title: "Core: API keys and media tokens (security view)"
description: "API keys are 32 random bytes stored hashed, with client, admin and metrics scopes; the client holds a client key and an admin key used only behind a step-up; core's API listener is docker-internal and answers 404 without a key; media tokens are scoped, expiring and revocable."
tags: [security, api-keys, core, requirement]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T12:00:00Z" }
code_refs:
  - "packages/core/src/"
status: stable
---

Source of truth for this topic 

- **API keys** are 32 random bytes, stored hashed, created and revoked with
  core's CLI (`multitap api-key create --scope client|admin|metrics --label my-app`)
  or through `/v1/admin`. `client` covers browsing, sessions, tokens, profiles
  and events. `admin` adds addons, engines, keys, ranking and `/metrics`.
  `metrics` (added in phase 2, migration `0005`) covers only `/metrics`, for a
  Prometheus scraper; it implies nothing else. A valid key without the needed
  scope gets `403`.
- **Last use:** a key's `last_used` is written at most once a minute per key,
  concurrent requests included, and the request doesn't wait for the write: a
  busy database never fails the request it authenticates; a failed write is
  logged (`warn`) and the key's next request tries again. `GET /v1/whoami`
  answers from the key as verified for that request, with no second read.
- **Revoking a key** (CLI or `DELETE /v1/admin/api-keys/{id}`) makes every
  later request with it a `404`, and ends its open `/v1/events` streams at
  their next event or heartbeat (at once through the API; within about a
  second more from the CLI, [[architecture/core-events-sse]]). Media
  tokens it minted stay valid until they expire or are revoked themselves
  ([[concept/media-tokens]]); `SECURITY.md` says so.
- The client holds a `client` key for normal use and an `admin` key used only
  behind an admin's step-up (Passkeys for admins and super-hosts).
- In a typical setup the API listener stays on a private network. Exposed or
  not, requests without a valid key get `404`, not `401`. Every request
  carries a key, so core warns at startup when the API listens on a
  non-loopback address over plain HTTP
  ([[architecture/network-and-deployment-exposure]]).
- **Reporting vulnerabilities:** `SECURITY.md` at the repository root holds
  core's threat model (hostile addons, an internet-facing media listener,
  trusted key holders within their scope, an engine with no auth), what is
  in and out of scope, and the private contact.
- **Media tokens** are covered in [[concept/media-tokens]]. They're scoped to one session, carry an
  expiry, and can be revoked per subject or all at once.

Related: [[architecture/core-v1-api]], [[concept/media-tokens]], [[architecture/secrets-policy]].
