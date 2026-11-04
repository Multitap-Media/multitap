## 2026-11-03
* **Update**: Engine-side preparation merged upstream as rivulet-engine#73 (Rivulet Engine v0.30.0, `RIVULET_HLS_PREPARE`). Updated `architecture/engine-prepare-ahead.md`, `process/engine-upstream-prs.md`, `process/upstream-engine-asks.md`, `process/upstream-engine-asks-table.md`, `process/build-plan.md`, `architecture/engine-abr-ladder-design.md` and `process/engine-abr-ladder-phasing-and-risks.md`, and the `process/index.md` entry.

## 2026-11-01
* **Update**: Updated concepts `architecture/engine-endpoints-core-uses.md` and `architecture/engine-prepare-stream.md` (the all-zero info hash is refused as `unsupported` and never reaches an engine).
* **Update**: Updated concepts `fact/engine-baseline.md` (upstream is now Rivulet Engine: the project renamed at v0.26.0, `RIVULET_*` settings from v0.27.0 with `STREMIO_*` silently ignored), `architecture/overview.md`, `architecture/goals-and-non-goals.md` and `process/upstream-engine-asks.md` (the new name and tracker URL), and their `fact/index.md`, `architecture/index.md` and `process/index.md` entries.

## 2026-10-29
* **Update**: Updated concept `decision/core-public-repo-fresh-history.md` (the commits made while the repository was private were squashed into the first commit, tagged `v0.2.0` and dated 2026-10-29; the secrets scan of the squashed history) and its `decision/index.md` entry, and `process/core-release.md` (`v0.2.0` is dated 2026-10-29).
* **Update**: Updated concepts `architecture/goals-and-non-goals.md` (Multitap isn't tied to one engine; stremio-server-go is the one developed and tested with) and `architecture/overview.md` (the engine is a separate streaming server), and the overview's `architecture/index.md` entry.
* **Update**: Updated concept `decision/core-licence.md` (scripts, docs, the knowledge bundle and the other repository files are AGPL-3.0-only under the root `LICENSE`) and its `decision/index.md` entry.
* **Creation**: Documented concept `decision/release-without-approval.md` (releases need no per-release approval), linked from `process/core-release.md`, `decision/index.md` and `project-map.md`.
* **Update**: Updated concept `process/secrets-sweep.md` (staged and unstaged changes are scanned as files with `betterleaks fs`, since betterleaks 2.0.0-rc.5 dropped `git --staged`/`--unstaged`).

## 2026-10-26
* **Update**: Updated concept `process/core-release.md` (packing: `files`, `publishConfig.exports`, `pnpm run build` and `pnpm run pack:check`).
* **Creation**: Started this bundle with Multitap's own repository: the design concepts, decisions, processes, facts and discoveries that Multitap's code and documents cite, and the October 2026 adversarial review (`core-review/`), carried over from the project Multitap was first built in and rewritten where they described that project, its apps or its deployment. New: `project-map.md`; rewritten: `architecture/overview.md`, `architecture/goals-and-non-goals.md`, `architecture/boundary-rule.md`, `architecture/network-and-deployment-exposure.md`, `architecture/security-trust-domains.md`, `architecture/core-deployment.md`, `decision/no-reverse-proxy-dependency.md`, `decision/core-public-name-multitap.md`, `decision/core-public-repo-fresh-history.md`, `process/build-plan.md`, `process/core-release.md` (`vX.Y.Z` tags) and `process/risk-register.md` (Multitap and engine risks only).
