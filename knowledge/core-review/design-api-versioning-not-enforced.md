---
type: Finding
title: "Finding: the /v1 compatibility guard is not in CI, and the versioning promise contradicts itself"
description: "The design says oasdiff runs in CI and additive-only changes stay in /v1, but `pnpm run ci` never runs api:diff, api:diff crashes on exit on Windows, and the changelog allows breaking /v1 changes with a minor bump."
tags: [core, review, design, design-api, api, versioning]
generated: { by: agent/mcp, at: "2026-10-20T11:54:47Z" }
code_refs:
  - "scripts/ci.js"
  - "scripts/api-diff.js"
  - "CHANGELOG.md"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw.
- **Verdict:** confirmed (read of `scripts/ci.js` plus a real `api:diff` run).

## Where

- `scripts/ci.js:25-33`: the CI steps are lint, typecheck, `api:check`, test, secrets scan, and (Linux only) contract. `api:diff` is not among them.
- `scripts/api-diff.js`: the oasdiff check itself; needs `oasdiff` on the PATH or in WSL.
- [architecture/core-api-testing](../architecture/core-api-testing.md) (table row "Breaking changes": "oasdiff, in CI"), [decision/contract-first-api](../decision/contract-first-api.md) ("oasdiff in CI"), [architecture/core-v1-api](../architecture/core-v1-api.md) ("Additive changes stay in `/v1`, and CI enforces it").
- `CHANGELOG.md:6-17`: "A breaking `/v1` change needs a minor bump and an entry here"; "while core is 0.x, semver gives no stability promise".

## What happens

1. Nothing automatic stops a breaking `/v1` change: `pnpm run ci` passes with one. The guard exists only as a manual command (and a release-skill step), so the design's "CI enforces it" is not true today.
2. On Windows, `pnpm run api:diff` prints its report and then exits with `-1073741819` (an access violation), so a script or hook that trusts its exit code fails even when there is nothing to report (already on the roadmap under "Verification gaps").
3. Two version axes say different things: the path says `/v1` (conventionally a stable major), while the changelog allows breaking `/v1` changes on any minor `0.x` bump. An outside client has no way to know which promise holds, nor a version to check at runtime: `info.version` is only in `/openapi.json` (needs a key) and `/healthz` returns `{status}` only.

## Evidence

```
pnpm run api:diff
api:diff: packages/api/openapi.json against core-v0.1.4
No breaking changes to report, but the specs are different.
[ELIFECYCLE] Command failed with exit code -1073741819.
```

`scripts/ci.js` steps list, read on branch `claude/core-adversarial-review-d6781b`.

## Fix direction

Run `api:diff` (failing on ERR against the last `core-v*` tag) as a CI step on Linux, fix or sidestep the Windows exit crash, and write the user-facing versioning policy the roadmap asks for: either "/v1 is stable from 1.0; 0.x may break with a changelog entry" or keep `/v1` additive-only now and move breaking changes to `/v2`. Expose the core version unauthenticated (e.g. in `/healthz` or a header) so clients can feature-detect.

## Resolution (2026-10-20, branch claude/wizardly-sutherland-9f41b5)

- `pnpm run ci` runs `api:diff --optional` (skipped with a warning only where oasdiff is missing; on Windows WSL's copy is used). A deliberate breaking change passes only when listed in `packages/api/breaking-accepted.txt`. Outside a git checkout (the `linux-run.sh` copy) it reports "not a git checkout" instead of a silent "no baseline".
- The exit crash did not reproduce on Node 26.10: 13 runs from PowerShell, Git Bash and a shelled `spawnSync`, all exit 0.
- One promise, in the changelog's "Versioning rules", the README and [[architecture/core-v1-api]]: additive by default; a breaking `/v1` change only on purpose, in a minor 0.x release with a changelog entry; none from 1.0 (they go to `/v2`).
- Not done: the core version readable without a key (`/healthz` still returns only `status`). It is on the ROADMAP.

## Public-release blocker

Yes: outsiders building on `/v1` need a written compatibility promise and an enforced check behind it before publication.
