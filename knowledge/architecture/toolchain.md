---
type: Architecture
title: Runtime and tooling choices
description: "Node 26 and pnpm 12, the tool chosen for each area and why (Hono + zod-openapi, Vitest, Playwright, pino, Prometheus client, jose, better-sqlite3, Kysely, Renovate…), what is wrapped or written in-house, and what is deliberately not used."
tags: [toolchain, node, pnpm, dependencies, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:35:51Z" }
code_refs:
  - "package.json"
  - "pnpm-workspace.yaml"
status: stable
---

Source of truth for this topic ("Runtime", "Tooling", "Wrapped or written in-house" and "Deliberately not used").

**Runtime.** Node **26**, the current release; it becomes LTS in October 2026 (supported to April 2029). Pin it with `.nvmrc` and `engines`, and use `node:26-alpine` images. Package manager: **pnpm 12**, pinned in `packageManager`. Node 25+ no longer bundles corepack, so pnpm is installed with `npm install -g pnpm` per nvm-managed Node.

**Tooling.** Chosen for longevity: each one implements a standard, is effectively a platform piece, or has a large user base behind it. Anything less certain sits behind one of our own interfaces so replacing it touches one module.

| Area | Tool | Why |
|---|---|---|
| API | Hono + `@hono/zod-openapi`, `openapi-typescript` + `openapi-fetch`, Schemathesis, oasdiff, Prism | see [[architecture/core-api-testing]] |
| Validation and config | **zod** | Schemas for the API, WS messages and events; env/config parsed and validated at startup |
| Tests | **Vitest** | Part of the Vite project; one runner for core, the client and the client app |
| Browser and sync tests | **Playwright** | Several browser contexts in one test ("3 viewers within 0.5 s"), WebKit as an early Safari check, clock control for drift |
| Logging | **pino** | Structured JSON logs; path **redaction** keeps tokens, manifest URLs and `mediaURL`s out of logs at `info` and above, and is off at `debug`/`trace` ([[architecture/secrets-policy]]) |
| Metrics | **@prometheus-io/client** | Prometheus format, the same as server-go's `/metrics`, so one dashboard covers engine and core. Switched from the deprecated `prom-client` to the official Prometheus `@prometheus-io/client` (v0.16.1), behind `metrics/` |
| Media tokens | **jose** (HS256 JWTs) | Standards-based, no dependencies, pins the algorithm and checks expiry. Revocation stays ours ([[concept/media-tokens]]). `hono/jwt`, already installed, is the zero-dependency alternative but has no key rotation. |
| CORS, SSE | `hono/cors`, `hono/streaming` | Built into Hono; no extra dependency |
| SQLite | **better-sqlite3** | Mature, synchronous. Ships prebuilt binaries (glibc, musl, Windows, macOS), so set `allowBuilds: { better-sqlite3: false }` in `pnpm-workspace.yaml` to skip a redundant `node-gyp` build. Node's built-in `node:sqlite` replaces it once stable in our LTS; the database layer keeps that a small change. |
| Queries and migrations | **Kysely** | Thin typed SQL builder with its own migrator; no hidden behaviour and no engine binary |
| Lint and format | **ESLint + typescript-eslint + Prettier**, **dependency-cruiser** | Long-standing defaults; dependency-cruiser enforces the package boundaries ([[architecture/boundary-rule]]) |
| Dependency updates | **Renovate** | Grouped update PRs with pinned versions; the main defence against slow rot |
| Releases (once core has its own repo) | **Changesets** | Versions and changelogs for `core-api` and core's image |

**Wrapped or written in-house:**
- **Release-name parsing** (`selection/parse`, see [[concept/source-ranking]]): `@viren070/parse-torrent-title` (MIT, TypeScript, actively released, one maintainer) behind our interface; only `selection/parse/name.ts` imports it. Our own rules sit on top (`.ts` container vs TeleSync, DV profiles, HLG, `W x H` sizes) plus extractors for addon layouts (Torrentio's seeders/size lines, Easynews++'s size/duration, debrid-cached tags). Measured on a hand-labelled set of 149 real names at ≥97% per field. If the package goes quiet, vendor it.
- **SRT/ASS → WebVTT** ([[architecture/core-subtitles-and-player-state]]): our own converter (~150 lines). The libraries are small and often stale.
- **Rate limiting** ([[architecture/security-trust-domains]]): a small SQLite-backed per-IP/per-email limiter in `packages/auth`, used by the client on every public path. It is the only limit the client relies on; a proxy's `rateLimit` or CrowdSec can be added by an operator, never assumed.
- **Prepare-job scheduling** ([[architecture/engine-prepare-ahead]]): a loop over `prepare_jobs`. No queue library, and no Redis.

**Deliberately not used:** Stremio's JS client libraries (effectively unmaintained; stremio-core's types plus our own addon client instead), Prisma (heavy for SQLite), Turborepo/Nx (pnpm workspaces suffice, and core is leaving the monorepo), tRPC (see [[decision/contract-first-api]]), and OpenTelemetry for now (logs plus Prometheus are enough at this size).

Related: [[architecture/overview]], [[decision/contract-first-api]].
