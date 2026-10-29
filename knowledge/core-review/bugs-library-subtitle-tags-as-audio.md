---
type: Finding
title: "Review finding: subtitle tags (ENG-SUB, VOSTFR, SUBFRENCH, Multi Subs) count as audio languages in ranking"
description: "parse/name.ts takes the release-name parser's languages as audio languages and ignores its subbed flag, so ENG-SUB gives a Korean-audio release the English bonus and VOSTFR gives an original-audio release the French mismatch penalty."
tags: [core, review, bugs-library, selection, parsing, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:12:31Z" }
code_refs:
  - "packages/core/src/selection/parse/name.ts"
  - "packages/core/src/selection/rank.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/selection/parse/name.ts:159-170` (languages taken as-is; `subbed` ignored), scored by `packages/core/src/selection/rank.ts` (language bonus and mismatch penalty, [source ranking](../concept/source-ranking.md) rule 6).

## What happens

- `Show.S01E01.1080p.WEB-DL.KOR.ENG-SUB.mkv` → languages `['eng', 'kor']`: an English-preferring profile gives Korean audio the +100 preferred-language bonus.
- `Movie.2020.1080p.VOSTFR.mkv` (original audio, French subtitles) → `['fre']`: an English-preferring profile gets the −200 mismatch penalty for a release that most likely has English audio.
- `SUBFRENCH` behaves the same; Torrentio's "Multi Subs" line becomes `mul`.

So ranking prefers the wrong audio for anime and Asian releases tagged with subtitle languages, and buries French-subtitled originals.

## Evidence

`packages/core/test/review-poc/bugs-library/selection-parse-bugs.test.ts`: the ENG-SUB, VOSTFR and VOSTFR-scoring tests (`it.fails`).

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/selection-parse-bugs.test.ts
```

## Fix direction

Drop languages that come only from subtitle tokens (`*-SUB`, `SUB*`, `VOST*`, "Subs"), e.g. strip those tokens before parsing languages, or expose them separately as subtitle languages.

## Public-release blocker

No; wrong ranking, not wrong playback.
