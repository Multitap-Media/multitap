---
type: Decision
title: "Schema-first API: zod-openapi, generated client, contract tests"
description: "Core's /v1 routes are declared once with zod schemas; the OpenAPI document and client are generated, never hand-written. Schemathesis, oasdiff and Prism check and use it. tRPC and oRPC were rejected."
tags: [api, openapi, zod, contract, decision]
generated: { by: agent/mcp, at: "2026-10-09T15:11:45Z" }
status: stable
---

**Decision.** The API is schema-first ([[architecture/core-api-testing]]). Each route is declared once with zod schemas for params, body and responses (`@hono/zod-openapi`). The OpenAPI 3.1 document is generated, and so are the typed client (`openapi-typescript` + `openapi-fetch`) and its checks. Never hand-write the OpenAPI document or the client.

**Tooling.**
- Schemathesis in CI (`pnpm run contract`), with stateful mode following OpenAPI `links` on responses. Lifecycle routes must declare links, so new ones are covered by the stateful phase. Harness: `packages/core/test/contract/run.ts`, passes `read`, `client`, `admin`. `GET /v1/events` is left out (SSE never ends).
- oasdiff in CI (`pnpm run api:diff`, a step of `pnpm run ci`) against the latest `core-v*` tag; deliberate breaking changes are accepted in `packages/api/breaking-accepted.txt` ([[architecture/core-v1-api]], Versioning).
- The client's client is generated from the document, not core's source, so an API change shows as a type error in the client.
- Prism serves a mock for client work.

**Not covered by the contract run (hand-written tests):** library progress rules, ranking and `playable`, retention, token expiry and revocation, SSE event payloads (zod schemas in `packages/api`), and `/media` (a byte proxy, not in the document).

**Rejected.** tRPC (end-to-end types only between TypeScript apps, no language-neutral contract). oRPC (can emit OpenAPI, but Hono + zod-openapi is more established).

**Rules.** Every `/v1` route declares its error responses too. Lifecycle routes declare `links`. Generated files are committed (`api:generate`). Procedure: Adding or changing a /v1 route in core.

Source: [[architecture/core-api-testing]], [[architecture/overview]] tooling table; AGENTS.md "Commands".
