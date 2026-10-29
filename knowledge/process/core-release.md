---
type: Process
title: "Release procedure (vX.Y.Z)"
description: "How to cut a Multitap release: choose patch versus minor from the API change, bump the three package versions, rename the changelog's Unreleased block, regenerate OpenAPI, commit, tag vX.Y.Z, let the release workflow publish the image, check api:diff, and the commit-after-pipe pitfall."
tags: [release, core, tags, process]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
code_refs:
  - ".github/workflows/release.yml"
  - ".claude/skills/release/SKILL.md"
---

Also the `release` skill (`.claude/skills/release/SKILL.md`). No per-release approval is needed ([[decision/release-without-approval]]). Never force-push.

**Version choice.** Additive `/v1` change (route, optional field): patch `0.2.x`. Breaking `/v1` change: minor bump and a "Breaking changes" changelog note. `api:diff`, part of `pnpm run ci`, fails on a breaking change (response-enum additions included) unless `packages/api/breaking-accepted.txt` lists it. The policy, from 1.0 no breaking `/v1` changes, is in [[architecture/core-v1-api]] and the changelog's "Versioning rules".

**Steps (repo root, clean tree on `main`):**
1. `pnpm run ci` green (plus `pnpm run contract` if routes, schemas or contract config changed).
2. Set `version` in `packages/core/package.json`, `packages/api/package.json` and `packages/addon-protocol/package.json`; `docs:check` compares them.
3. `CHANGELOG.md`: rename the Unreleased entries to `## X.Y.Z (YYYY-MM-DD)` and leave an empty Unreleased above.
4. `pnpm run api:generate` (OpenAPI `info.version` is the release), then `pnpm run ci` again.
5. Commit `chore: release X.Y.Z`.
6. `git tag -a vX.Y.Z -m "Multitap X.Y.Z: <one line>. See CHANGELOG.md"`, then push `main` and the tag.
7. The tag runs `.github/workflows/release.yml`: it checks the tag against `packages/core`'s version, builds the image for amd64 and arm64, pushes `ghcr.io/multitap-media/multitap` as `X.Y.Z`, `X.Y` and `latest` with provenance and an SBOM, and creates the GitHub release from the CHANGELOG section.
8. `pnpm run api:diff` should report nothing against the new tag. If the release shipped accepted breaking changes, empty `packages/api/breaking-accepted.txt` (keep its comment): the new tag is the baseline.
9. Update doc version mentions (README status, ROADMAP header), then `pnpm run docs:check`.

**Packing.** Each package packs only its `files` (`dist/`; `openapi.json` for `@multitap/api`; `migrations/` and `dev/` for `@multitap/core`), and `publishConfig.exports` points the packed manifest's `types` and `default` at `dist/`, with no `development` condition. Build `dist/` with `pnpm run build`, which also rewrites the declarations' `./x.ts` specifiers to `./x.js` and copies hand-written `.d.ts` files, before `pnpm pack`. `pnpm run pack:check`, part of `pnpm run ci`, packs the three packages, installs them into a project outside the workspace and imports and typechecks them there.

**Pitfall.** Never chain `git commit` after `pnpm run ci | grep`: the pipe hides CI's exit status. Read the `ci: ok` line or use `set -o pipefail`.

Tags in this repository: `v0.2.0` (2026-10-29, the first commit). Earlier releases (0.1.0 to 0.1.4) were tagged in the original repository: [[fact/core-release-history]].

Related: [[decision/core-public-repo-fresh-history]].
