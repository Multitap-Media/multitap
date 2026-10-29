---
type: Finding
title: Quadratic regexes on addon text freeze core (ReDoS)
description: "Several regexes in subtitle conversion and stream-name parsing run in quadratic time on addon-controlled text, so one hostile stream or subtitle file blocks core's event loop for minutes to hours."
tags: [core, review, security, sec-input, redos, dos]
generated: { by: agent/mcp, at: "2026-10-20T03:13:38Z" }
code_refs:
  - "packages/core/src/subtitles/convert.ts"
  - "packages/core/src/selection/parse/extractors.ts"
  - "packages/core/src/selection/parse/index.ts"
status: stable
---

Part of the [sec-input review](sec-input-progress.md).

- **Severity:** high. **Kind:** security.
- **Verdict:** confirmed.
- **Status:** fixed on 2026-10-20: linear patterns and capped stream text. See "Fix" below.
- **Where:**
  - `packages/core/src/subtitles/convert.ts:106` (`/\{\\[^}]*\}/g` in `srtText`)
  - `packages/core/src/subtitles/convert.ts:176` and `:178` (`/\{[^}]*\\p[1-9]/`, `/\{[^}]*\}/g` in `assText`)
  - `packages/core/src/selection/parse/extractors.ts:40` (`SIZE`, unanchored `\d+` then a unit; `parseSize` runs on the whole description plus name)
  - `packages/core/src/selection/parse/index.ts:19` (`/\[[^\]]*\]/g` in `labelText`, on the stream `name`)

## What happens

Each regex scans to the end of the input from every candidate start when the closing character never comes, so the time is quadratic in the length. Core is one Node process: while it runs, every route stalls, the gateway included, so all viewers' playback stops.

- Streams: `parseStream` runs on every stream of every addon when a source list is built (`selection/candidates.ts:144`), with no user choice involved. A stream `description` of digits or a `name` of `[` characters is enough. Addon responses may be 8 MiB, so one stream can block for hours.
- Subtitles: conversion runs when a viewer loads a track; files may be 5 MiB. A failed conversion isn't cached, so each request repeats it.

Measured on this machine (one call each): subtitle `{\` text at 10k / 20k / 40k characters took about 0.4 / 1.4 / 6.7 s; `parseSize` on 10k / 20k / 40k digits about 0.8 / 3.0 / 11.5 s; `labelText` on 40k `[` about 3.7 s. Extrapolating, the size caps allow hours.

## Evidence

The PoC was `packages/core/test/review-poc/sec-input/redos.test.ts`; since the fix it is the normal test `packages/core/test/addon-text-redos.test.ts`. Four tests, then `it.fails`,, each asserting a 20k-character input finishes under 100 ms; all four exceed it. `pnpm vitest run packages/core/test/review-poc/sec-input/redos.test.ts`.

## Fix direction

Make the patterns linear (for example `\{[^}{]*\}`, `\[[^\][]*\]`, anchor or bound `\d{1,15}` in `SIZE`), cap the length of strings before parsing (name, description and cue text a few KiB), and add a time-bound fuzz test for every regex over addon text. Keep the third-party title parser's input bounded too.

## Public-release blocker

Yes: any installed addon can take core down for every user with one response.

## Orchestrator verification (2026-10-20)

An independent verifier agreed: the finding **holds at high**.
- **Measured in plain Node.** `parseSize` takes 1.2 s at 20k digits, 4.5 s at 40k and 18.5 s at 80k: clearly quadratic.
- **The response cap doesn't help.** The 8 MiB cap still allows hours of a blocked event loop, which stops every session and the gateway.
- **No length limit exists anywhere.** `StreamSchema` has no `.max`.
- **No pick is needed.** Streams are parsed on every source listing.

Release blocker: **yes**.

## Fix (2026-10-20)

- **Linear patterns.**
  - `subtitles/convert.ts`: `\{\\[^{}]*\}`, `\{[^{}]*\\p[1-9]` and `\{[^{}]*\}`. A brace class no longer spans the `{` it looks for, so a run of unclosed braces is scanned once.
  - `selection/parse/extractors.ts`: `SIZE` starts only where a number starts (`(?<!\d)`) and bounds its digits (`\d{1,15}`).
  - `selection/parse/index.ts`: `labelText` uses `\[[^[\]]*\]`.
- **Found while fixing, same pattern.** Timing every regex over addon text turned up three more, all quadratic and now linear:
  - `subtitles/convert.ts`: `shiftWebVtt`'s `/\n+$/` on a WebVTT file with a long run of newlines, reached with any offset. It is now a loop.
  - `selection/item-meta.ts`: `parseRuntime` on a meta `runtime` of digits. It now uses `(?<!\d)`.
  - `selection/match.ts`: `nameForms` on a meta `name` with a long run of spaces (`\s*\(year\)$` and `^(.+?)\s*[:–—]\s`). It now trims instead of matching `\s*`.
- **Length caps.** The stream schema in `@multitap/addon-protocol` cuts `name`, `description`, `title`, `behaviorHints.filename` and `bingeGroup` to `STREAM_TEXT_MAX_CHARS` (4096). It cuts rather than refuses, so a stream stays usable. That bounds the third-party release-name parser and every later consumer ([addon aggregation](../concept/addon-aggregation.md)).
- **Tests.** The four PoC cases pass as normal `it`s in `packages/core/test/addon-text-redos.test.ts`. Beside them, every pattern above is timed on a megabyte of hostile input (under 1 s; quadratic would be hours), with checks that the patterns still read what they did before.
