---
type: Decision
title: "Releases need no per-release approval"
description: "Maintainer decision 2026-10-29: when finished work warrants a release, bump, tag vX.Y.Z and push it without asking first, although the tag publishes the GHCR image and a GitHub release; never force-push."
tags: [release, decision, process]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-29T18:30:00Z" }
status: stable
---

**Decision (maintainer, 2026-10-29).** Cutting a Multitap release needs no per-release approval. When finished work warrants one, follow [[process/core-release]] (the `release` skill): bump the three package versions, move the CHANGELOG's Unreleased entries, regenerate the OpenAPI document, run the checks, commit, tag `vX.Y.Z` and push `main` and the tag. The rule holds although a pushed tag runs `.github/workflows/release.yml`, which publishes the image to `ghcr.io/multitap-media/multitap` and creates the GitHub release.

What stays as it was:
- Additive `/v1` changes get a patch release; a breaking change gets a minor release with a "Breaking changes" note, accepted on purpose for `api:diff`.
- Never force-push, and never move or delete a pushed tag: a fix ships as the next patch release.
- Other pushes follow the usual rule in `AGENTS.md`: only when asked.

It continues the standing permission core's releases had before Multitap got its own repository (from 2026-10-06).

Related: [[process/core-release]], [[fact/core-release-history]].
