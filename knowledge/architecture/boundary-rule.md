---
type: Architecture
title: "Boundary rule: Multitap knows nothing about the apps built on it"
description: "Features that only make sense with several viewers, several devices or people belong in clients, never in Multitap; inside the repository, dependency-cruiser enforces which package may import which."
tags: [architecture, boundaries, scope]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
code_refs:
  - ".dependency-cruiser.cjs"
  - "eslint.config.js"
---

**The rule.** Anything that only makes sense with several viewers, several devices or people (rooms, watch-party sync, roles, invites, accounts, device presence) belongs in a client built on Multitap's `/v1` API, never in Multitap. Multitap offers the generic pieces such features need: playback sessions any number of players can join through media tokens, per-subject token revocation, profiles and their libraries, and events ([[architecture/core-scope]]).

**Package boundaries** (`.dependency-cruiser.cjs`, run by `pnpm lint`):
- `packages/core` imports only `packages/api`, `packages/addon-protocol` and itself.
- `packages/api` imports only `packages/addon-protocol`: the client never pulls in the server.
- `packages/addon-protocol` imports nothing from the workspace.
- Runtime code (`src/`) never depends on a devDependency, nothing is circular, and every import resolves (except in the browser-only `/dev` page).

ESLint adds that workspace packages are imported by name only, never by a deep or relative path, and never from `dist/`.

Related: [[architecture/overview]], [[architecture/goals-and-non-goals]].
