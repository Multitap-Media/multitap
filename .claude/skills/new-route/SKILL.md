---
name: new-route
description: Checklist for adding or changing a /v1 route in Multitap (schema, route, scopes, errors, links, tests, contract, docs, changelog). Use when adding an endpoint, a response field or a request parameter to Multitap's API.
---

# Adding a `/v1` route

Schema-first: never hand-write the OpenAPI document or client.

1. **Schemas** in `packages/api/src/<area>.ts` (zod, with `.meta`/openapi
   descriptions and examples). Export types; re-export from `index.ts`.
   Prefer additive changes. Adding a value to a **response enum** (a status,
   an event type, a failure reason) is a breaking change for `api:diff`,
   which `pnpm run ci` runs: accept it on purpose in
   `packages/api/breaking-accepted.txt`, with a minor bump and a
   "Breaking changes" changelog entry (the changelog's "Versioning rules").
2. **Route** in `packages/core/src/http/routes/<area>.ts` with
   `createRoute` from `@hono/zod-openapi`: tag, summary, request schemas
   (query/params/body), **every response it can return**: 2xx plus 400, 401/404
   (unauthenticated gets 404 by design, okf:architecture/core-api-keys-security), 403 (wrong scope), 404, 409,
   410, 422, 429, 501 as applicable, with problem bodies (`http/problem.ts`).
   Register it in `http/app.ts`; put new dependencies in `AppDeps`
   (`http/types.ts`) as optional fields with a lazily built default for tests.
3. **Scope**: `client` for `/v1/*`, `admin` for `/v1/admin/*`, `metrics` only
   for `/metrics`. Check `auth/middleware.ts`.
4. **No secrets out**: never return raw `Stream`s, `mediaURL`s, manifest
   URLs, tokens or key hashes; use the `*_PUBLIC_COLUMNS` lists; log session
   id and subject, never paths or URLs at `info`.
5. **Validation = documentation**: don't normalise input (trimming etc.) in a
   way the schema doesn't state; the contract run catches it.
6. **Lifecycle routes** (create → get → …): declare OpenAPI `links` on the
   responses so the stateful contract phase follows them.
7. **Time and randomness** come from the injected `Clock`/`IdGenerator`.
8. **Tests** (`packages/core/test/…`): route tests against the fake engine / fake
   addons, table-driven where there are rules, manual clock for time. Events
   must validate against their schema. Offline only.
9. `pnpm run api:generate` (commit `openapi.json` and `src/schema.d.ts`), then
   `pnpm run ci`, then `pnpm run contract` (see `contract-triage`).
10. **Docs**: the route table in okf:architecture/core-v1-api (and the concept that owns the
    behaviour), `README.md`, `CHANGELOG.md` under
    Unreleased, new env vars in okf:architecture/configuration and the README table, the
    roadmap if it closes an item. `pnpm run docs:check` verifies routes, env
    vars and migrations against the docs.
11. Release when it warrants one (`release`).
