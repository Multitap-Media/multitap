---
type: Decision
title: "The public name is Multitap"
description: "Decision 2026-10-25: the project is published as Multitap. Why the name, the namespaces registered for it (GitHub org Multitap-Media, npm @multitap, multitap.dev, ghcr.io/multitap-media) and the names it sets for packages, image, CLI, variables, metrics and files."
tags: [core, naming, publishing, decision]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
---

**Decision (2026-10-25):** the project is published as **Multitap**. It is the technical piece; most people who watch through it never see its name.

The name plays on the cable-TV multitap, the box on the line that splits one feed out to many outlets: one Multitap serving many clients and devices.

## Why

- No media or streaming project used the name. The checks of 2026-10-25 were a registry sweep (GitHub, GitLab, npm, crates.io, Docker Hub and others) and a web search.
- Its other uses are elsewhere: a multiplayer rollback SDK (`@multitapio/multitap` on npm), retro controller adapters, an audio "multitap delay" effect and a Burp Suite extension.
- A quick search found no trademark for streaming software. A direct USPTO/EUIPO search is still worth doing.

## Namespaces

| Place | Name | Note |
|---|---|---|
| GitHub | org `Multitap-Media`, repository `Multitap-Media/multitap` | `multitap` is a dormant personal account. |
| npm | org `@multitap` | The unscoped `multitap` package was free on 2026-10-25 but isn't registered. |
| Domain | `multitap.dev` | `project@multitap.dev` is the security contact in `SECURITY.md`. |
| Container image | `ghcr.io/multitap-media/multitap` | GitHub Container Registry under the org; Docker Hub organizations are paid-only. |

## The names it sets

- Packages `@multitap/core` (the server, `packages/core`), `@multitap/api` (`packages/api`) and `@multitap/addon-protocol` (`packages/addon-protocol`); the client exports `createMultitapClient`, `MultitapClient` and `MultitapEvent*`.
- The CLI `multitap`; every environment variable but `NODE_ENV` starts with `MULTITAP_`, and every metric with `multitap_`.
- The addon `User-Agent` `Multitap/<version> (+https://multitap.dev)` and the OpenAPI title `Multitap API`.
- The files `multitap.sqlite`, `multitap.<date>.<n>.log` and backup ids `multitap-<UTC timestamp>`.

There were no public users when the name was applied, so no old names are kept as aliases (`CHANGELOG.md`, 0.2.0). Security reports go to `project@multitap.dev`; once the repository is public, GitHub's private vulnerability reporting can be a second channel.

Related: [[decision/core-public-repo-fresh-history]], [[decision/core-licence]].
