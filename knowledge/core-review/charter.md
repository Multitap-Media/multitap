---
type: Process
title: "Core adversarial review (2026-10): charter, areas, finding format"
description: "Scope, threat model, review areas and workers, severity scale and the finding concept format for the pre-publication adversarial review of core (packages/core and packages/api)."
tags: [core, review, security, parity, process]
generated: { by: agent/mcp, at: "2026-10-20T02:58:19Z" }
status: draft
---

Started 2026-10-19 on branch `claude/core-adversarial-review-d6781b`. Orchestrated from one session; each area has a worker session that writes its findings into this folder.

## Goal

Before core goes public: can the general public run it safely and build on it? Not a perfect v1.0. Specifically:

1. Core does at least most of the basics Stremio's own core (`stremio-core`, the official Rust crate) does: the addon protocol, catalogs and search, meta, streams, subtitles, library and watched state, continue watching. Gaps are expected; they are recorded, not fixed.
2. Few to no architectural or design flaws.
3. Existing security issues and bugs found, with evidence.

**In scope:** `packages/core`, `packages/api`, and whatever core relies on in `packages/shared` and `packages/addon-protocol`. **Out of scope for code review:** the engine (stremio-server-go) and the client/client app. They may be named as the *source* of an issue found while validating against a real engine or real addons.

The review **finds and records**. It does not fix code; fixes are follow-ups chosen by the maintainer.

## Threat model for a public release

- **Addons are hostile.** Anyone may install any addon URL; manifests, catalogs, metas, streams and subtitles are attacker-controlled input (size, timing, shape, URLs pointing at private hosts).
- **The gateway listener faces the internet.** Anyone can send it requests; a media token holder is a browser, not a trusted client.
- **API key holders are trusted clients**, but scopes must hold: a key with fewer scopes must not do more.
- **The engine has no auth** and must only be reachable by core; core must not let anything else steer it into arbitrary fetches beyond what the design allows.
- **Operators are not experts.** Unsafe defaults, silent misconfiguration and footguns count as findings.

## Areas and workers

| Area slug | Covers |
|---|---|
| `sec-access` | API keys and scopes, media tokens and revocation, gateway authorization, CORS and TLS, the two listeners, backups and dev routes, CLI, config defaults, secrets in logs, the Docker image. |
| `sec-input` | Hostile addon input: SSRF and private hosts, fetch limits (size, time, redirects), response validation, subtitle fetch and conversion, name parsing (ReDoS), URLs handed to the engine, SSE and event-bus abuse, metrics cardinality, resource exhaustion. |
| `bugs-playback` | Sessions, the engine module (resolve, prepare, health, registry, retention, transport), the gateway's streaming lifecycle, events and SSE, idempotency, concurrency and restart recovery. |
| `bugs-library` | Addon collection and aggregation, browse routes, selection and ranking, library service and rules, watched bitfield, profiles, player state, persistence, migrations and backups' data integrity. |
| `parity` | Feature parity against `stremio-core` and `stremio-addon-sdk`: what core has, has partly, lacks, or leaves out on purpose (per `ROADMAP.md`). |
| `design-api` | Architecture and design flaws: `/v1` API consistency, error model, OpenAPI quality, versioning, the boundary rule (no app concepts in core), configuration, persistence model, extensibility, packaging and docs for outside users, test quality. |

Each area keeps `core-review/<area>-progress` (status, what was checked, low findings, links to its finding concepts). The orchestrator writes `core-review/summary` at the end.

## Finding concepts

One concept per finding of severity **medium or above**: `core-review/<area>-<short-slug>`, type `Finding`, status `draft`. Low and info findings go in a table in the area's progress concept. Body sections:

- **Severity:** critical / high / medium / low / info. **Kind:** security / bug / design-flaw / gap.
- **Verdict:** `confirmed` (reproduced: a test, a script or a real run, with the command) / `plausible` (read from code, not reproduced) / `disputed` (the orchestrator settles it).
- **Where:** `file:line` references (also listed in `code_refs`).
- **What happens:** the concrete input or state and the wrong outcome.
- **Evidence:** the test, PoC or real run and its output, redacted per the secrets rules.
- **Fix direction:** one or two sentences; not a fix.
- **Public-release blocker:** yes / no, with one line why.

Severity, for a public release: **critical** lets an outsider (no key) take control, read secrets or reach the engine freely; **high** breaks a security property for some deployments or loses user data; **medium** is a real bug or flaw a normal user will hit, or a security weakness needing unusual conditions; **low** is minor; **info** is a note.

## Rules for workers

- Read-only on code: no edits under `packages/` or `scripts/`. Proof-of-concept tests go in `packages/core/test/review-poc/<area>/`; a PoC that shows a bug uses `it.fails` (or `test.fails`) so the suite stays green. Other scratch work goes in the worker's own scratchpad.
- Never commit or push. The orchestrator commits.
- Secrets rules from `AGENTS.md` apply in full: no addon URLs, stream URLs, keys or addresses in findings.
- Pass the absolute bundle path to every `okf_*` write. Only write your own area's concepts.

## Status

Done 2026-10-20. Verdict, counts, release blockers and settled disputes: [summary](summary.md). Per-area detail:

- [bugs-library progress](bugs-library-progress.md)
- [bugs-playback progress](bugs-playback-progress.md)
- [design-api progress](design-api-progress.md)
- [parity progress](parity-progress.md)
- [sec-access progress](sec-access-progress.md)
- [sec-input progress](sec-input-progress.md)
