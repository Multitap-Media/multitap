---
type: Finding
title: "Finding: core has no licence, so nobody may legally run, fork or build on it"
description: "There is no LICENSE file anywhere in the repository and no `license` field in any package.json; published as is, core would be all-rights-reserved. Runtime dependencies are all MIT or Apache-2.0, so any common licence is open."
tags: [core, review, design-api, readiness, licence]
generated: { by: agent/mcp, at: "2026-10-20T11:55:55Z" }
code_refs:
  - "package.json"
  - "packages/core/package.json"
  - "packages/api/package.json"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** gap.
- **Verdict:** confirmed (file listing and package manifests).

## Where

- Repository root, `packages/core/`, `packages/api/`, `packages/addon-protocol/`: no `LICENSE*` file.
- `package.json`, `packages/core/package.json`, `packages/*/package.json`: no `license` field (all are `"private": true`).
- `ROADMAP.md`, "Dependency and licence audit": "core's own licence: **none is chosen yet** (MIT is the likely choice, undecided)".

## What happens

Code published without a licence is under default copyright: outsiders may read it but not legally run a modified copy, fork it, or ship a client that vendors `@multitap/api`. That defeats the goal of a public core others "run and build on", and package registries (npm for the typed client, a container registry for the image) will show it as unlicensed.

Runtime dependency licences, read from each package's `package.json`: `@hono/node-server`, `@hono/zod-openapi`, `@viren070/parse-torrent-title`, `better-sqlite3`, `hono`, `jose`, `kysely`, `pino`, `pino-roll`, `undici`, `zod`, `openapi-fetch` are MIT; `@prometheus-io/client` is Apache-2.0. Nothing constrains the choice (Apache-2.0 needs its NOTICE handling if bundled). The engine (stremio-server-go) is a separate upstream project with its own licence and is used as a service, not linked.

## Evidence

```
ls LICENSE* packages/core/LICENSE* packages/*/LICENSE*     # no such file, for all three
grep -n '"license"' package.json packages/core/package.json packages/*/package.json   # no match
```

## Fix direction

Choose a licence (the roadmap leans MIT), add `LICENSE` at the root of the repository core is published from and a `license` field in `@multitap/core`, `@multitap/api` and `@multitap/addon-protocol`, and an OCI `org.opencontainers.image.licenses` label on the image.

## Resolution (2026-10-20, branch claude/wizardly-sutherland-9f41b5)

The maintainer chose AGPL-3.0-only for core and its image, and MIT for `@multitap/api` and `@multitap/addon-protocol`, with DCO sign-off and no CLA ([[decision/core-licence]]). Added: `packages/core/LICENSE`, `packages/api/LICENSE`, `packages/addon-protocol/LICENSE`, the `license` fields, the image's `org.opencontainers.image.licenses` label and `/app/LICENSE`, and `CONTRIBUTING.md`. The client and client app still have no licence.

## Public-release blocker

Yes: without a licence the public can't lawfully use it.
