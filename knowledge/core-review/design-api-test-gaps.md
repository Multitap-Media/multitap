---
type: Finding
title: "Finding: the production wiring, upgrades with data and restore are untested, and CI is local only"
description: "Vitest never plays through `startCore` (tests rebuild the composition root by hand, with auto-select's source list stubbed); the full root runs only in the Linux-only contract run and opt-in e2e; table-rebuild upgrades with data, down migrations and restore have no test; there is no coverage tool and no hosted CI."
tags: [core, review, design-api, tests, readiness]
generated: { by: agent/mcp, at: "2026-10-20T11:57:54Z" }
code_refs:
  - "packages/core/src/index.ts"
  - "packages/core/test/"
  - "scripts/ci.js"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** gap (test quality).
- **Verdict:** confirmed for the absences listed (grep and reading, partly by a review subagent and spot-checked); that a wiring bug would slip through is inferred, not reproduced.

## Where

- `packages/core/src/index.ts:58-186` (`startCore`, the production composition root). Vitest uses it only in `packages/core/test/cors-tls.test.ts` (listeners, CORS, TLS) and `packages/core/test/cli.test.ts` (a CLI key authenticates): no test creates a session or fetches media through it.
- `packages/core/test/session-setup.ts:93-200`, `packages/core/test/gateway.test.ts:89-104`, `packages/core/test/helpers.ts:58-79`: each rebuilds the wiring by hand. The session rig stubs `autoSources` (`session-setup.ts:143`, `() => Promise.resolve(rig.autoList)`), so auto-select tests never touch addon aggregation; the real `autoSourcesFor` is used in only four files. The engine is the in-process fake transport except in two gateway tests.
- `packages/core/test/phase2-schema.test.ts:222-275`: the only upgrade-with-data test (0004). Nothing upgrades through 0005's table rebuild with rows present, and no `down` migration is run. No test restores a backup and starts core on it (restore is a manual README procedure).
- `scripts/ci.js:22,47`: the contract run (the only automated run of the real root with a real HTTP engine double) is skipped unless on native Linux or with `--contract`; e2e is opt-in. There is no `.github/` (CI runs only on the maintainer's machine) and no coverage configuration in `vitest.config.ts` or any `package.json`.

## What happens

The unit and route tests are good where they reach (auth and scopes, media tokens and the gateway, library rules, config, the CLI, all real code with no `vi.mock`), but the seams between modules are exercised in a wiring that differs from production (`profiles` and timeouts differ in the session rig; services are not started in production order). A mistake in `index.ts` or `http/selection-deps.ts` passes `pnpm run ci` on Windows. For outside contributors there is no hosted CI to run their pull requests, and no coverage number to tell them where tests are thin. The migration and restore paths, where a public user's data is at risk, have the least coverage (see [design-api-migration-safety](design-api-migration-safety.md)).

## Evidence

```
grep -rln "startCore" packages/core/test     # cli.test.ts, cors-tls.test.ts (plus review-poc)
grep -n "coverage" vitest.config.ts package.json   # no match
ls .github                                # no such directory
```

`pnpm run contract` (WSL, this review): all three passes ok (about 14,000 generated cases, 0 failures); Schemathesis reports the profile library and item-state routes never reached with real ids (no links from `listProfiles`/`createProfile` to them).

## Fix direction

Add a few end-to-end vitest cases that start `startCore` against the fake engine over HTTP (create, ready, mint, fetch a segment, release, restart); upgrade tests that seed rows before each data-carrying or rebuilding migration; a restore test; a coverage report; and hosted CI on Linux and Windows (the roadmap's "CI on GitHub").

## Public-release blocker

No for the code itself; hosted CI is a blocker for accepting outside contributions.
