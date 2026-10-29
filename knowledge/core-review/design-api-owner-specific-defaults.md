---
type: Finding
title: "A fresh install and its docs assume the maintainer's deployment"
description: "Fixed 2026-10-20 to 2026-10-26: first start seeded an engine `home` with one mini-PC's capabilities and made it the default, the README described one deployment instead of a setup anyone can follow, and the API title, the addon User-Agent and the code comments carried the original project's name."
tags: [core, review, design-api, docs, publishing]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
code_refs:
  - "packages/core/src/engines/index.ts"
  - "packages/core/src/config.ts"
  - "packages/core/migrations/0004_home_engine_phase0.ts"
  - "README.md"
  - "packages/core/src/http/openapi.ts"
status: stable
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw (operator footgun) and gap (docs for outside users). **Public-release blocker:** yes.
- **Verdict:** confirmed, then fixed.

## What it was

- On an empty database core created an engine `home` with the reference deployment's capabilities (QuickSync, tone mapping, 1080p live, concurrency 2) and `SELECTION_DEFAULT_ENGINE` defaulted to `home`. An outside operator's first sessions would have run against an engine that didn't exist, with capabilities that didn't fit theirs. Migration `0004_home_engine_phase0` is a data migration keyed to that earlier seed; it stays, since databases record it, and it only touches a row that still matches the old seed exactly.
- The README described the maintainer's engines and linked into repository-internal docs, so an outsider couldn't follow it as a quickstart.
- The OpenAPI title, the default addon `User-Agent` and about 270 code comments carried the original project's name and design references.
- The boundary rule held in **code**: no room, party, guest or member logic existed in core. Only names and wording leaked.

## Resolution

- 2026-10-20: core seeds no engine. Until an admin adds one with `PUT /v1/admin/engines/{id}`, source lists and sessions answer `400` saying so, and core logs a warning at startup. `MULTITAP_SELECTION_DEFAULT_ENGINE` has no default: unset, a request that names no engine uses the only engine there is. The README was rewritten for outside users: a generic engine setup with each capability explained. The OpenAPI document lost its `okf:` and phase references and its app-specific examples.
- 2026-10-25: the public name is applied to the title, the `User-Agent` and every other name ([[../decision/core-public-name-multitap]]).
- 2026-10-26: Multitap has its own repository, and the design concepts its comments cite are this repository's own bundle ([[../decision/core-public-repo-fresh-history]]).
