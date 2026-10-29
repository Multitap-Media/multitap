---
type: Process
title: "Core review: design-api progress"
description: "Progress, coverage, low findings and links to medium+ findings for the design-api area (/v1 API quality, architecture and boundary, configuration, persistence model, public readiness) of the core adversarial review."
tags: [core, review, design, api, design-api]
generated: { by: agent/mcp, at: "2026-10-20T11:58:48Z" }
status: draft
---

Area `design-api` of the [core adversarial review](charter.md). Started 2026-10-20, done 2026-10-20.

## Status

Done. 7 medium findings (3 public-release blockers: versioning, deployment-specific defaults, licence), 13 low, 6 info. Nothing critical or high: the API is coherent, contract-first and well tested at the unit level; the flaws are in conventions, defaults, upgrade safety and readiness for outsiders.

## Checked

- **OpenAPI inventory:** a script over `packages/api/openapi.json` listing each of the 63 operations with its id, tags, description, examples, links, declared statuses and content types, and every list response's shape.
- **Error model:** `packages/core/src/http/problem.ts`, every `ProblemError`/`problemResponse` call site, and the session error mapping. PoC `packages/core/test/review-poc/design-api/error-model.test.ts`.
- **Versioning:** `scripts/ci.js`, `scripts/api-diff.js` and the CHANGELOG rules. Ran `pnpm run api:diff`: no breaking changes against core-v0.1.4, then it exits with -1073741819 on Windows.
- **Contract and generation:** `pnpm run api:check` reports the document and client as current. `pnpm run contract` ran through WSL with `GIT_DIR`/`GIT_WORK_TREE` set and `WORK=~/multitap-ci-design-api`: passes `read`, `client` and `admin` all ok, 0 failures.
- **Boundary rule:** grep of `packages/core/src` and `packages/api` for room, party, guest, member, the old project name, phase and okf:. Code holds the rule; the wording doesn't.
- **Architecture:** engine coupling (`engines/module.ts`, `engines/index.ts`, `index.ts`, `http/selection-deps.ts`), single-process state and tenancy.
- **Config:** the `config.ts` schema and its cross-field checks.
- **Persistence:** `db/index.ts` and migrations 0003 to 0005. PoC `packages/core/test/review-poc/design-api/migration-fk-cascade.test.ts`, now a normal test in `packages/core/test/migrations.test.ts`.
- **Readiness:** README claims against routes and CLI commands (all routes and CLI commands it names exist), the Dockerfile, licences, `pnpm audit --prod --filter @multitap/core --filter @multitap/api --filter @multitap/addon-protocol` ("No known vulnerabilities found"), and test quality (subagent sweep, spot-checked).

PoCs: `pnpm vitest run packages/core/test/review-poc/design-api` gives 3 expected fails. Each fails for the stated reason when switched to `it`.

## Findings (medium and above)

| Finding | Severity | Verdict | Blocker |
|---|---|---|---|
| [Problem bodies have no machine-readable kind](design-api-error-model.md) | medium | confirmed | no |
| [The /v1 compatibility guard is not in CI; the versioning promise contradicts itself](design-api-versioning-not-enforced.md) | medium | confirmed | **yes** |
| [Migrations with foreign keys on and no backup: a table rebuild would erase libraries](design-api-migration-safety.md) | medium | confirmed; fixed 2026-10-20 | no (latent) |
| [A fresh install and its docs assume the maintainer's deployment](design-api-owner-specific-defaults.md) | medium | confirmed | **yes** |
| [No licence](design-api-no-licence.md) | medium | confirmed | **yes** |
| [No pagination convention, unbounded library, two list shapes](design-api-list-conventions.md) | medium | plausible | no |
| [Production wiring, upgrades with data and restore untested; CI local only](design-api-test-gaps.md) | medium | confirmed | no (yes for outside contributions) |

## Low and info findings

| # | Severity | Kind | Where | Note |
|---|---|---|---|---|
| L1 | low | gap | `packages/api/openapi.json`, `packages/core/src/http/openapi.ts` | OpenAPI quality: 79 of 87 schemas and 12 of 63 operations have no description (e.g. `listProfiles`, `getProfile`, `deleteProfile`, `listEngines`, `createApiKey`). There is no `servers`, top-level `tags` or `info.license`, and `405`/`413`/`415`/`500` aren't declared on most operations. No OpenAPI linter runs. |
| L2 | low | design-flaw | `packages/core/src/http/routes/{addons,api-keys,engines,profiles}.ts` | `links` are missing on several lifecycle creates: `addAddon` (to update/refresh/remove), `createApiKey` (to revoke), `putEngine`, and `listProfiles`/`createProfile` to the library and item-state routes. As a result the contract run never reaches those routes with real ids (Schemathesis "missing test data"). |
| L3 | low | design-flaw | `api-keys.ts`, `profiles.ts`, `ranking.ts` | DELETE semantics vary. `revokeApiKey` answers 200 with the key, `removeFromLibrary` 200 with the item, `resetRankingSettings` 200 with the settings; every other DELETE answers 204. |
| L4 | low | design-flaw | `packages/api/src/sessions.ts` (`MintToken.ttl`), `EngineStatus.durationSec`, `ParsedSource.durationSec` | Units are mixed. Durations are ms everywhere (`*Ms`, `time`, `duration`) except the token `ttl`, which is seconds with no suffix and is described against `MEDIA_TOKEN_TTL_MS`, and two `*Sec` fields. Timestamps are consistently ISO 8601. |
| L5 | low | design-flaw | `sessions.ts`, `selection-deps.ts:82` | Status codes don't line up. An unknown `profileId` on `/v1/streams` and session create is 400, while every profile route answers 404. An unknown engine is 400 on session create. |
| L6 | low | design-flaw | POST routes | Only session create is idempotent (by `key`). A retried `createProfile`, `createApiKey` or `mintMediaToken` creates duplicates, and there's no `Idempotency-Key` convention. |
| L7 | low | design-flaw | `packages/core/src/http/selection-deps.ts`, `packages/core/src/http/types.ts` | `AppDeps` makes `sessions`, `gateway`, `library`, `backups` and `ranking` optional, and the HTTP layer silently builds its own (a second `EngineRegistry` and `ServerGoEngineModule`) when one is missing. That's a second composition root kept for tests. Production passes all of them today; a future omission would split in-memory state with no error. |
| L8 | low | design-flaw | `packages/core/src/index.ts:118`, `selection-deps.ts:138`, `packages/api/src/engines.ts` | One engine implementation is hard-wired in two places. The engine descriptor has no engine `kind`, so a second engine type (another streaming server) needs a descriptor field and a module registry. That can be added later; the `EngineModule` interface is already clean (only `OpenSubHash` comes from `server-go-types`). |
| L9 | low | design-flaw | `packages/core/src/config.ts` | About 60 environment variables without a prefix (`API_PORT`, `DATA_DIR`, `NODE_ENV`, `LOG_LEVEL`, …), and unknown variables are ignored. A typo such as `CORS_ORIGIN` or `MEDIA_PUBLIC_URL` is silent, and the generic names collide in shared environments. A `CORE_` prefix would allow warnings for unknown `CORE_*` names. |
| L10 | low | gap | `Dockerfile` | `EXPOSE` lists 8080 only (the media port 8081 is missing). The image copies the `dev/` page into production. The base image isn't pinned by digest. The header's `-p 8080:8080` example is recorded by sec-access ([sec-access-api-listener-public-default](sec-access-api-listener-public-default.md)). |
| L11 | low | gap | `scripts/linux-run.sh`, `scripts/contract.js` | `pnpm run contract` fails from a git worktree on Windows: `fatal: not a git repository`, because the worktree's `.git` file holds a Windows path. Workaround: export `GIT_DIR` and `GIT_WORK_TREE` in WSL. The fixed `WORK=~/multitap-ci` also collides between concurrent runs. Developer tooling only. |
| L12 | low | gap | `packages/api/package.json` | The typed client isn't publishable as is. It is `private`, `default` points at an unbuilt `dist/` (it has no build script of its own, only `tsc -b` from the app), and it has no `files`. It was also named under the old scope (roadmap "Naming review" and "Publish the typed client"). |
| L13 | low | gap | `packages/core/src/metrics/index.ts:98` | The gauge `event_subscribers_total` still carries a counter suffix (roadmap item open). |
| I1 | info | design-flaw | `selection/stream-store.ts`, `events/memory-bus.ts`, addon breakers and caches, gateway viewers | Core assumes a single process. Candidate keys, event replay, circuit breakers and viewer telemetry are in memory. A restart invalidates outstanding candidate keys (409) and `Last-Event-ID` replay; two processes on one database are unsupported. None of this is stated in the README. |
| I2 | info | design-flaw | `auth/middleware.ts` | Core is single-tenant. Every `client` key sees and changes every profile, library and session, and there is no ownership per key. That fits the threat model ("key holders are trusted") but should be stated for people building multi-user apps on core. |
| I3 | info | gap | `/v1` | There is no capability discovery. A client learns that `delivery: direct`/`remux`, `mode: full` or `readyBy` aren't built only from a 501, and `/healthz` reports no version (see [versioning](design-api-versioning-not-enforced.md)). |
| I4 | info | note | dependencies | `pnpm audit --prod` finds no known vulnerabilities in core's tree. Every runtime dependency is MIT except `@prometheus-io/client` (Apache-2.0), and versions are pinned exactly. |
| I5 | info | note | boundary rule | It holds in code. `packages/core` has no room, party, guest or member logic, and media-token `subject`s and viewers are generic. Only names, examples and docs leak ([owner-specific defaults](design-api-owner-specific-defaults.md)). |
| I6 | info | note | test suite | The unit and route tests are strong. They cover auth and scopes, forged, expired and revoked media tokens, library rules and config, use no `vi.mock`, and drive real modules. Gaps are in [design-api-test-gaps](design-api-test-gaps.md). There's no redirect test for addon fetches, which matches sec-input's [redirect SSRF finding](sec-input-addon-redirect-ssrf.md). |

## "Before publishing" checklist (ROADMAP.md), as of this review

Every item is still unchecked.

**Real blockers:**
- **Licence:** [finding](design-api-no-licence.md).
- **Versioning policy and api:diff in CI:** [finding](design-api-versioning-not-enforced.md).
- **README for outside users, and removing the original project's wording:** [finding](design-api-owner-specific-defaults.md).
- **Naming review:** settle names before the npm and registry names get baked in.
- **Secrets scan of the git history:** not checked here.
- **SECURITY.md:** none exists. Outsiders need a way to report.
- **Repository split:** the README linked into the original repository's deployment and phase docs.
- **Deployment guides:** include keeping the engine unreachable, since the engine has no authentication.
- **Hosted CI:** needed for outside pull requests.
- **The security review:** the other areas of this review.

**Should land first, not blockers:**
- Error model ([finding](design-api-error-model.md)).
- Pagination conventions ([finding](design-api-list-conventions.md)).
- OpenAPI quality pass (L1, L2).
- Metric rename (L13).
- Docker image on a real host, and the standalone TLS routes.
- Log redaction audit (the security areas).

**Fine after publishing:**
- API reference rendering, examples, release automation, CONTRIBUTING and templates.
- The flaky-test root cause.
- Publishing the client and the image (L12).

The api:diff Windows crash is confirmed still present.
