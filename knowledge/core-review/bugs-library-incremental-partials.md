---
type: Finding
title: "Review finding: incremental source lists drop early partials and never signal completion with a synthetic part"
description: "In source-list.ts an addon that answers before the meta lookup finishes hits a temporal-dead-zone ReferenceError that aggregate swallows, so its streams.partial event is never sent; and when a meta-embedded or yt_id synthetic part exists, no partial ever carries remaining 0."
tags: [core, review, bugs-library, selection, events, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:12:31Z" }
code_refs:
  - "packages/core/src/selection/source-list.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/selection/source-list.ts:129-133` (`aggregate`'s `onOutcome` calls `emit`), `:213-214` (`let partials`, declared only after `await lookup` and `await collection.get(...)`), `:224` (`remaining + (synthetic ? 1 : 0)`), `:244` (`emit(own, 0)` for the synthetic part).

## What happens

1. **Lost partials.** `emit` is a hoisted function declaration, but the `let partials` it assigns is declared further down, after two awaits. An addon whose outcome arrives before those awaits finish (a cached response, an open circuit, a fast local addon, a slow meta addon) calls `emit` while `partials` is in its temporal dead zone: a `ReferenceError`, which `aggregate`'s try/catch around `onOutcome` swallows. That addon's `streams.partial` event is never published. The final (non-incremental) result still has its candidates, but an incremental client (`GET /v1/streams?...&incremental=true`, which only gets partials over `/v1/events`) never sees them.
2. **No completion.** When the list has a synthetic part (streams embedded in the meta, or the stream derived from a `yt_id:` id), every partial adds 1 to `remaining`, including the synthetic part's own, emitted with `remaining` 0. The last partial says `remaining: 1`; a client waiting for 0, as documented, waits forever.

## Evidence

`packages/core/test/review-poc/bugs-library/selection-source-list-bugs.test.ts`: "an addon answering before the meta lookup finishes still gets its partial" (partials `[]` instead of one) and "with a meta-embedded part, the last partial says remaining 0" (`it.fails`). Not caught by `packages/core/test/events.test.ts`, whose meta lookup is fast.

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/selection-source-list-bugs.test.ts
```

## Fix direction

Declare `partials`, `built` and `build` before calling `aggregate` (or queue outcomes until setup is done), and don't add the synthetic 1 when emitting the synthetic outcome itself.

## Public-release blocker

No, but incremental lists are the documented way to show sources fast; silently missing addons and a list that never completes are visible.
