---
type: Finding
title: "Review finding: \"DV 5.1\" is parsed as Dolby Vision profile 5, so the source is marked unplayable"
description: "The DV_PROFILE regex in parse/name.ts reads an audio channel layout after a DV tag (DV 5.1, DV 7.1) as the Dolby Vision profile, so a normal HDR release gets unplayableReason dv5 and auto-select never picks it."
tags: [core, review, bugs-library, selection, parsing, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:12:31Z" }
code_refs:
  - "packages/core/src/selection/parse/name.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/selection/parse/name.ts:115-116` (`DV_PROFILE`: `(?:P|Profile[ ._]?)?0?([4-9])(?:\.\d+)?` makes the `P`/`Profile` prefix optional).

## What happens

`Movie 2021 2160p WEB-DL DV 5.1 H265.mkv` parses as `dvProfile: 5`, so the candidate gets `unplayableReason: 'dv5'` (profile 5 has no HDR10 fallback): it ranks as unplayable and auto-select skips it. The `5.1` is the audio layout. `DV 7.1` likewise yields profile 7. Release names put the audio layout right after the HDR tag often enough for this to drop good 4K sources.

## Evidence

`packages/core/test/review-poc/bugs-library/selection-parse-bugs.test.ts`, "an audio channel layout after DV…" (`it.fails`).

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/selection-parse-bugs.test.ts
```

## Fix direction

Require the `P`/`Profile` prefix for a bare number, or reject `N.1` (5.1, 7.1, 2.0) channel layouts as profiles.

## Public-release blocker

No; a ranking error, but one that hides playable 4K sources.
