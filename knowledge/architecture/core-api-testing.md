---
type: Architecture
title: "Building and testing the core API: zod-openapi, Schemathesis, oasdiff, fakes"
description: "How core's API is built and tested: routes declared once with zod and @hono/zod-openapi, generated client, Schemathesis contract tests with stateful links, oasdiff against the last release, the client's equivalent, Prism, what the contract cannot cover, fakes, and why not tRPC."
tags: [core, api, testing, contract, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/test/contract/"
  - "packages/api/"
status: stable
---

Source of truth for how the API is built and tested 

The API is the part most likely to rot, so its contract is machine-readable
and most of its tests are generated from that contract rather than written by
hand.

| Job | Tool | Notes |
|---|---|---|
| Define routes | **Hono + `@hono/zod-openapi`** | Each route is declared once with zod schemas for params, body and responses. Requests are validated from them, and the **OpenAPI 3.1 document is generated**, never hand-written. The same zod schemas can be imported by the client and the client app. |
| Client | **`openapi-typescript` + `openapi-fetch`** | The client's client is generated from the OpenAPI document, not from core's source. A change to core's API shows up as a type error in the client. |
| Contract tests | **Schemathesis**, in CI | Generates requests from the schemas (edge cases, invalid input, missing or wrong-scope keys) and checks every response against the document: no 5xx, documented status codes and shapes. **Stateful mode** follows OpenAPI links, declared on the routes' responses (create session → get/update → mint token, revoke all, viewers, subtitles → release; create profile → report progress → library → continue watching → next, delete), so lifecycle sequences are exercised without writing them. The harness (`packages/core/test/contract/run.ts`) runs core against fake addons and the fake engine as `home`, in three passes (`read`, `client`, `admin`). `GET /v1/events` is left out of the run: an SSE response never ends; Vitest covers it. New endpoints are covered as soon as they're declared. |
| Breaking changes | **oasdiff**, in CI | `pnpm run api:diff`, a step of `pnpm run ci`: diffs the generated document against the last release (the last `core-v*` tag) and fails on changes that would break a `/v1` client (`ERR`), unless `packages/api/breaking-accepted.txt` accepts them (the versioning rule is in [[architecture/core-v1-api]]). Where oasdiff isn't installed `ci` skips it with a warning; on Windows WSL's copy is used. The Linux copy made by `scripts/linux-run.sh` has no `.git`, so there it reports "not a git checkout" and skips: run it in the checkout. Before the first tag existed it only reported against `main` ([[process/build-plan]]). |
| Developing against Multitap | **Prism** | A mock server from the same document, for client work without a running Multitap |

**What the contract can't cover** (hand-written; this suite grows with features,
not with endpoints):
- **Behaviour rules:**
  - library progress rules, as table-driven fixtures ported from stremio-core
  - ranking and the `playable` annotations ([[concept/source-ranking]])
  - retention (`max(retainUntil, lastAccess + idle)`)
  - token expiry, per-subject revocation and `tokenEpoch`
- **Events.** OpenAPI describes SSE poorly. Event payloads are zod schemas in
  `packages/api`, every event emitted in tests is validated against them,
  and an AsyncAPI document can be generated later if outside clients need one.
- **`/media`.** It's a byte proxy, not JSON, so it isn't in the OpenAPI
  document. A few tests cover token checks, the filename allowlist, `410` for
  released sessions, and not aborting upstream `.ts` requests ([[architecture/media-gateway-proxy]]).

**Fakes.** Contract and behaviour tests run core against a **fake engine** and
a **fake addon**: small fixture-driven HTTP servers that mimic the server-go
endpoints core uses ([[architecture/engine-endpoints-core-uses]]) and the addon protocol. Runs are offline and
deterministic, like upstream's own rule for engine tests. The real engine is
exercised in the phase 0 spike and in manual end-to-end checks.

**Not chosen:** tRPC gives end-to-end types only between TypeScript apps and
produces no language-neutral contract, which a standalone core needs. oRPC can
emit OpenAPI and would work, but Hono + zod-openapi is more established.

Related: [[decision/contract-first-api]], [[architecture/core-v1-api]], [[architecture/engine-endpoints-core-uses]].
