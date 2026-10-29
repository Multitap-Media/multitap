---
name: release
description: Cut a Multitap release (bump the three package versions, changelog, regenerate OpenAPI, CI, commit, tag vX.Y.Z). Use when asked to release, tag or bump Multitap, or when finished work warrants a new version.
---

# Releasing Multitap

Process and rules: okf:process/core-release. No per-release approval is needed
(okf:decision/release-without-approval): release when finished work warrants
it. Never force-push, and never move a pushed tag.

## Choose the version
- Additive `/v1` change (new route, optional field) → patch (`0.2.x`).
- Breaking `/v1` change → **minor** bump and a "Breaking changes" note in the
  changelog. `pnpm run api:diff` (part of `pnpm run ci`) tells you: it fails
  unless the change is listed in `packages/api/breaking-accepted.txt`
  (oasdiff flags response-enum additions too). The policy is in the changelog's
  "Versioning rules": from 1.0, breaking changes go to `/v2` instead.

## Steps (from the repo root, clean tree on `main`)
1. `pnpm run ci` must be green first. Run `pnpm run contract` too if any route,
   schema or contract config changed.
2. Set `"version"` in `packages/core/package.json`, `packages/api/package.json`
   **and** `packages/addon-protocol/package.json` (`docs:check` compares them).
3. `CHANGELOG.md`: rename the entries under `## Unreleased` to
   `## X.Y.Z (YYYY-MM-DD)` and leave an empty `## Unreleased` above it.
4. `pnpm run api:generate` (the OpenAPI `info.version` is the release), then
   `pnpm run ci` again.
5. Commit `chore: release X.Y.Z`.
6. `git tag -a vX.Y.Z -m "Multitap X.Y.Z: <one line>. See CHANGELOG.md"`
7. Pushing the tag to GitHub runs `.github/workflows/release.yml`, which builds
   and pushes the image and creates the GitHub release.
8. `pnpm run api:diff` should report no changes against the new tag. If the
   release shipped accepted breaking changes, empty
   `packages/api/breaking-accepted.txt` (keep its comment) in the next
   commit: the new tag is the baseline now.
9. Update doc mentions of the current version (README status, ROADMAP header),
   then `pnpm run docs:check`.
10. Packages are packed from `dist/`: `pnpm run build` first, then `pnpm pack`
    (`pnpm run pack:check`, in `pnpm run ci`, proves they work outside the workspace).

## Pitfall
Never chain `git commit` after `pnpm run ci | grep ...`: the pipe hides CI's
exit status. Use `set -o pipefail`, or run CI alone and check `$?`, or read the
`ci: ok` line before committing.
