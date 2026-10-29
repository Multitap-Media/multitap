---
type: Finding
title: "Review finding: torrent candidate keys ignore fileMustInclude and filename, so pack episodes share a key"
description: "A torrent candidate's key is built from infoHash and fileIdx only, but without fileIdx core chooses the file by fileMustInclude or behaviorHints.filename; two episodes of one pack get the same key, and listing one episode overwrites the stream store entry the other's key plays."
tags: [core, review, bugs-library, selection, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:12:31Z" }
code_refs:
  - "packages/core/src/selection/candidates.ts"
  - "packages/core/src/engines/resolve.ts"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium (kept; not a release blocker after verification). **Kind:** bug.
- **Verdict:** confirmed.
- **Where:** `packages/core/src/selection/candidates.ts:60` (`torrent: ['infoHash', 'fileIdx']`; the archive variants include `fileMustInclude`), `packages/core/src/engines/resolve.ts:100-118` (with no `fileIdx`, the file is chosen by `fileMustInclude`, else `behaviorHints.filename`).

## What happens

Addons that return a season pack's infoHash without `fileIdx` (the file named by `fileMustInclude` or `behaviorHints.filename`) give every episode of the pack the same candidate key and the same `sourceIdentity`. The stream store is keyed by it, so listing S01E02 replaces the stored stream behind the S01E01 key: a client that then plays the S01E01 candidate gets episode 2, and the session and last source record video `…:1:2`. The last-source bonus also cross-matches episodes of one pack.

## Evidence

`packages/core/test/review-poc/bugs-library/selection-candidates-bugs.test.ts` (three `it.fails` tests: distinct keys for distinct `fileMustInclude`, distinct keys for distinct `behaviorHints.filename`, and the store overwrite).

```bash
pnpm vitest run packages/core/test/review-poc/bugs-library/selection-candidates-bugs.test.ts
```

## Fix direction

Add `fileMustInclude`, and `behaviorHints.filename` when `fileIdx` is absent, to the torrent key material (whatever `resolve.ts` uses to pick the file must be in the key).

## Public-release blocker

Yes, arguably: a picked candidate can play a different episode than the one listed, which a normal user will notice and can't work around.

## Orchestrator verification (2026-10-20)

An independent verifier found that this **partly holds**. The shared key and the store overwrite are real. "Plays the wrong episode" is mostly refuted:
- **A pick by key fails safely.** It checks `stored.videoId` against the request (`sessions/service.ts:399-404`). After an overwrite, the episode 1 pick fails with `candidate-mismatch`, and the client lists the sources again.
- **Auto-select is what's left.** It reads `streams.get(candidate.key)` with no `videoId` check (`service.ts:904`). To play the wrong file, a listing of another episode from the same pack has to land between the list and the attempt, and it only happens with addons that send no `fileIdx`. Torrentio-style addons do send it.
- **The PoC covers less.** It tests the store only, not session create.

Release blocker: **no**. Add the `videoId` check to auto-select and put the file choice in the key.
