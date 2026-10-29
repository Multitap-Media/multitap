---
type: Finding
title: "Finding: problem bodies have no machine-readable kind, so clients must parse English detail text"
description: "Every /v1 problem is `type: about:blank` with no error code; the same status means several different things (400, 409, 404 for a bad key), so an outside client can only branch on `detail` strings."
tags: [core, review, design, design-api, api, errors]
generated: { by: agent/mcp, at: "2026-10-20T11:54:32Z" }
code_refs:
  - "packages/core/src/http/problem.ts"
  - "packages/core/src/http/routes/sessions.ts"
  - "packages/core/src/http/openapi.ts"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw.
- **Verdict:** confirmed (PoC test).

## Where

- `packages/core/src/http/problem.ts:52`: `problemBody` always sets `type: 'about:blank'`; `ProblemError` (`:80`) takes only a status, a detail and headers, so no call site can set a type or a code.
- `packages/core/src/http/routes/sessions.ts:85-94`: the session service has machine codes (`candidate-expired`, `candidate-mismatch`, `unknown-engine`, `unknown-profile`, `engine-busy`, …) and the route maps them to a status, then drops the code.
- `packages/core/src/http/problem.ts:75`, `packages/core/src/http/openapi.ts:13-22`: a missing, invalid or revoked key gets the same `404` body as an unknown route or resource, with no `WWW-Authenticate`.

## What happens

The same status covers unrelated failures, and nothing in the body says which:

- `400`: request validation (has `errors[]`), an unknown engine on session create, an unknown `profileId` on `/v1/streams` and session create, a body without a JSON `Content-Type`.
- `409`: an expired or unknown candidate key (list the sources again), an addon already installed, a backup already running, an engine still in use.
- `404`: no such resource, or the API key is bad. A client whose key was revoked sees every session and profile "disappear" and may delete its local state, instead of asking for a new key.

A client built from the OpenAPI document can only branch on the English `detail`, which is not part of the contract and changes freely. RFC 9457 expects `type` to identify the problem kind; the roadmap's "Error model review" (one documented list of problem types and codes) is open.

The 404-for-a-bad-key rule is a deliberate choice ([architecture/core-api-keys-security](../architecture/core-api-keys-security.md)); this finding does not dispute hiding the API from scanners, only that a key holder has no in-band way to learn its key is dead (it must call `/v1/whoami` and interpret a 404 there).

## Evidence

`packages/core/test/review-poc/design-api/error-model.test.ts` (two `it.fails` tests, using the real app from `testApp()`):

```
pnpm vitest run packages/core/test/review-poc/design-api
# with it.fails switched to it:
AssertionError: expected 'about:blank' not to be 'about:blank'          (unknown profile vs validation, both 400)
AssertionError: expected [ 'about:blank', null ] to not deeply equal [ 'about:blank', null ]   (missing profile vs bad key, both 404)
```

## Fix direction

Give `ProblemError` a `type` (a stable URI or relative reference per problem kind, e.g. `/problems/candidate-expired`) and pass the session service's codes through; document the list in the OpenAPI document. Consider a distinct `type` (still `404`) for a bad key, so the indistinguishability from scanners holds for status and timing but a key holder can tell.

## Public-release blocker

No: adding `type` values is additive to the schema. But do it before outside clients start matching `detail` text, which would then become a de facto contract.
