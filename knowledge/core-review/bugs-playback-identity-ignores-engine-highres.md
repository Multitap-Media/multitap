---
type: Finding
title: "Session idempotency ignores the engine and highRes, so a different request gets the old session"
description: "sessionIdentity hashes key, item, source, delivery and quality but not the requested engine or highRes, so a keyed create asking for another engine or high-res policy returns the existing session (200, created false) on the old engine with the old policy."
tags: [core, review, bugs-playback, sessions, idempotency]
generated: { by: agent/mcp, at: "2026-10-20T13:15:46Z" }
code_refs:
  - "packages/core/src/sessions/identity.ts"
  - "packages/core/src/sessions/service.ts"
status: draft
---

Area `bugs-playback` of the [core adversarial review](charter.md); listed in [bugs-playback progress](bugs-playback-progress.md).

- **Severity:** medium. **Kind:** bug (code against design: [playback-session](../architecture/playback-session.md) says the identity is what changes the session).
- **Verdict:** confirmed.

## Where

- `packages/core/src/sessions/identity.ts:30-57`: the fields hashed: key, item, source (`preferBingeGroup` for auto), delivery, quality; for auto-select also the request's languages and `profileId`.
- `packages/core/src/sessions/service.ts:421-424, 454-463`: the engine (`requiresEngine ?? request.engine ?? default`) and `highRes` are chosen before the identity, but neither goes into it.

## What happens

- **highRes:** auto-select ranks with the session's `highRes` ([source-ranking](../concept/source-ranking.md)): `off` excludes high-resolution sources, `on` allows them. A client that created `{key: 'room:1', source: {auto: true}, highRes: 'off'}` and then asks for `highRes: 'on'` (the maintainer changed the setting and pressed play again) gets the `off` session back, `created: false`. The identity's own comment says what changes the pick belongs in it, and `preferredLanguages` and `profileId` are there for that reason.
- **engine:** the same key with `engine: 'second'` returns the session on `home`. Latent while there is one engine, but the API already takes `engine`, and `ROADMAP`/[future-remote-engines](../architecture/future-remote-engines.md) plan several.

Related, low: a picked source's identity leaves out `profileId`, so a second profile creating with the same key gets the first profile's session; its last source isn't recorded and its player state's subtitle offset isn't applied.

## Evidence

`packages/core/test/review-poc/bugs-playback/sessions-identity-and-recovery.test.ts`, first two tests (with `it.fails` removed): `expected 'off' to be 'on'` for `highRes`, `expected 'home' to be 'second'` for the engine.

```
pnpm vitest run packages/core/test/review-poc/bugs-playback/sessions-identity-and-recovery.test.ts
```

## Fix direction

Hash the resolved engine id and `highRes` into the identity (and `profileId` for picked sources too), appended only when present, as the code already does for languages, so stored identities still match.

## Public-release blocker

No: wrong but recoverable (use another key); worth fixing with the next schema touch.
