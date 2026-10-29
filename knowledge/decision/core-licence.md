---
type: Decision
title: "Core licence: AGPL-3.0-only for core, MIT for the client packages, DCO without a CLA"
description: "Decision (2026-10-20): core (packages/core and its image) is AGPL-3.0-only so hosted forks stay open; @multitap/api and @multitap/addon-protocol are MIT so clients can use any licence; contributions are signed off under the DCO, with no CLA. Everything else in the repository (scripts, docs, the knowledge bundle) is AGPL-3.0-only under the root LICENSE (2026-10-29)."
tags: [core, licence, decision, publishing]
generated: { by: agent/mcp, at: "2026-10-20T20:44:01Z" }
status: stable
---

**Decision (2026-10-20).** The maintainer wants to give core away and keep it from being taken closed by a company ("protect a future community from corporate takeover"). Chosen:

| Part | Licence | Where |
|---|---|---|
| Core: `packages/core` and its container image | **AGPL-3.0-only** | `packages/core/LICENSE`, `"license"` in `packages/core/package.json`, `org.opencontainers.image.licenses` on the image and `/app/LICENSE` in it |
| `@multitap/api` (schemas, OpenAPI document, typed client) and `@multitap/addon-protocol` (addon protocol types and client) | **MIT** | `LICENSE` and `"license"` in each package |
| Everything else in the repository: scripts, docs, the knowledge bundle, CI and agent files | **AGPL-3.0-only** | the root `LICENSE` (2026-10-29) |

**Why AGPL for core.** MIT would let anyone host a changed core and share nothing. GPL-3.0 only binds distribution, and core is a server, so a hosted fork would not have to share either. AGPL-3.0 section 13 requires anyone who runs a changed core for others over a network to offer them its source. Running an unchanged core needs nothing more. "Only" rather than "or later" is literal to the maintainer's choice of AGPL-3.0.

**Why MIT for the client packages.** They are what apps and players import. Copyleft there would put off builders whose apps would otherwise not be bound; the server, the part worth protecting, stays AGPL. The boundary rules already keep the packages free of core code (`packages/api` and `packages/addon-protocol` never import `packages/core`).

**Contributions.** Signed off under the Developer Certificate of Origin 1.1 (`git commit -s`), with **no CLA**: contributors keep their copyright, so no single party, the maintainer or a later buyer included, can relicense the project closed without them. Inbound equals outbound: a contribution takes the licence of the part it changes. Written in `CONTRIBUTING.md` at the repository root.

**Everything else (2026-10-29).** The repository's other files fall under the root `LICENSE`, AGPL-3.0-only like core: one licence for everything that isn't a client package. The maintainer had no preference for another, and none fits better: the scripts and docs exist to build, check and explain the server.

**Compatibility.** Core's runtime dependencies are MIT plus one Apache-2.0 package ([[core-review/design-api-no-licence]]), both usable in AGPL-3.0 software. The engine (stremio-server-go) runs as a separate service and is not linked, so its licence is unaffected.

**Open.** A CI check that pull-request commits carry `Signed-off-by`, and issue and pull-request templates (ROADMAP.md).

Related: [core review summary](../core-review/summary.md), [the licence finding](../core-review/design-api-no-licence.md).
