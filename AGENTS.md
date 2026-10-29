# Agent instructions

Instructions for AI coding agents (and humans) working in this repository.
Read this, then the knowledge bundle and the README.

## Read first

- [knowledge/project-map.md](knowledge/project-map.md): the OKF bundle, start here. It **is** the design (it wins over the other documents), plus the decisions, processes, risks and the October 2026 review. Query it with `okf_search` before proposing architecture or substantial changes.
- [README.md](README.md): what Multitap does today, its configuration and API, and the test commands.
- [ROADMAP.md](ROADMAP.md): what is still to do. [CONTRIBUTING.md](CONTRIBUTING.md): licences and DCO sign-off. [SECURITY.md](SECURITY.md): the threat model.

## What this is

Multitap is a standalone, headless Stremio client with a remote engine. The repository is a pnpm workspace with three packages:

- `packages/core` (`@multitap/core`, AGPL-3.0-only): the server, its CLI and its container image.
- `packages/api` (`@multitap/api`, MIT): the zod schemas, the generated OpenAPI document and the typed client.
- `packages/addon-protocol` (`@multitap/addon-protocol`, MIT): Stremio addon protocol types and the addon HTTP client.

The **engine** is the streaming server Multitap drives over HTTP. Multitap isn't tied to one engine: it's developed and tested with [stremio-server-go](https://github.com/M0Rf30/stremio-server-go), an upstream project, and engines are registered as data (okf:architecture/goals-and-non-goals). Multitap knows nothing about the apps built on it: rooms, watch parties, people, accounts and devices belong in clients, never here.

## Hard rules

- **Engine:** treat it as having no authentication (stremio-server-go has none), so only Multitap may reach it. Changes to stremio-server-go go upstream as pull requests; Multitap detects each engine feature at runtime and keeps working without it.
- **Git:** commit or push only when asked; the exception is a release, which needs no per-release approval (okf:decision/release-without-approval). Never use bare `git stash`. Don't rewrite pushed history.
- **Secrets:** never commit manifest URLs, stream URLs, keys, account details, private hostnames or addresses, or credentials, in code, fixtures, docs or logs. Betterleaks scans every commit (`pnpm run secrets:install-hook` once per clone); run `pnpm run secrets:scan all` before pushing. Fixtures are redacted by rule (`packages/addon-protocol/test/fixtures/real/README.md`).
- **Design changes:** update the owning concept in `knowledge/` (find it with `okf_search`) in the same piece of work. When an upstream engine PR merges, turn its "once #NN merges" notes into present tense.
- **API:** schema-first with zod and `@hono/zod-openapi`. Never hand-write the OpenAPI document or the client (`pnpm run api:generate`). Lifecycle routes declare `links`. `/v1` changes are additive; a breaking change follows the CHANGELOG's "Versioning rules".
- **Boundaries** (enforced by dependency-cruiser): `packages/core` imports only `packages/api` and `packages/addon-protocol`; `packages/api` imports only `packages/addon-protocol`; `packages/addon-protocol` imports nothing from the workspace. Import workspace packages by name, never by deep or relative path.
- **No reverse proxy assumed:** nothing in Multitap depends on one.
- **CI:** Linux is the reference; Windows failures are real too.

## Commands

From the repository root, after `pnpm install` (Node 26, pnpm 12):

| Command | When |
|---|---|
| `pnpm run ci` | Before any commit that touches code: lint, typecheck, `api:check`, `api:diff`, `docs:check`, tests, `pack:check` (the packed packages used from outside the workspace) and the secrets scan (the contract run too on native Linux). |
| `pnpm run docs:check` | Before a docs-only commit. |
| `pnpm run api:generate` | After a route or schema change; commit `openapi.json` and `schema.d.ts`. |
| `pnpm run contract` | After a route change: Schemathesis against the generated document (Linux; on Windows it runs in WSL). |
| `okf validate knowledge --strict` | After a change to `knowledge/` (or the `okf_validate` MCP tool with `strict`). |

Windows notes: `node_modules` belong to the OS that installed them, so Linux checks never run from `/mnt/c`; `scripts/linux-run.sh <script>` copies the working tree into WSL and runs the script there. In a git worktree, WSL's git can't follow the worktree's Windows `gitdir` path: export `GIT_DIR` and `GIT_WORK_TREE` before calling it.

Releases are tagged `vX.Y.Z` (okf:process/core-release; the `release` skill). Pushing a tag runs `.github/workflows/release.yml`, which publishes the image to `ghcr.io/multitap-media/multitap`.

---

## 🧠 Persistent Project Memory (OKF v0.2)

> Powered by [OKF Agent Memory](https://github.com/okf-memory/okf-agent-memory) — Open Knowledge Format (OKF) v0.2 persistent project memory for AI agents.

### 1. Behavioral Invariants & Constraints (RFC 2119)
- MUST execute `okf_search(query=keywords, limit=3)` before proposing architecture, new dependencies, or substantial code changes.
- PREFER `okf_search` / `okf_show` over scanning `knowledge/` with `list_dir`, `grep_search` or `find` for lookups. Raw reads and edits are fine for bulk work (migrations, sweeps, link fixes) and for checking exact text; pass the absolute bundle path to `okf_*` writes.
- NEVER forge human verification (`verified:` is human-only; declare `generated: { by: "<actor>", at: "<iso-time>" }`).
- PREFER native `okf_*` MCP tools OVER CLI fallback commands.

### 2. Guard Clauses & Scope Governance
- ON edit(@path/):
    IF first_visit(@path/) => okf_search(for_path=@path/)
    IF governance == "hold" => STOP("Subsystem frozen by governance. Request explicit human confirmation.")
    IF governance == "constraint" => MUST adhere to all listed invariants
    IF governance == "context" => proceed with awareness
- ON user_query(architecture | requirements | conventions | domain_facts):
    okf_search(query=keywords, limit=3) => evaluate summary description
    IF relevant => okf_show(concept_id) ONLY on demand
    IF updating_existing_concept => PREFER okf_update OVER okf_create

### 3. Completion Pipeline (Sequential Assertion Gates)
1. IF arch_decisions_made => MUST okf_create(decision/*, type="Decision", title=..., desc=...)
2. IF requirements_discovered => MUST okf_update(concept_id)
3. IF concepts_mutated => MUST sync(knowledge/log.md, knowledge/index.md)
4. ASSERT(okf_validate(strict=true) == {errors: 0, warnings: 0}, ELSE=fix_before_exit). Where the `okf` binary is installed, `okf validate knowledge --strict --drift` is the fuller check.
