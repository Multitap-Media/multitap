---
type: Decision
title: "Preparation runs on the engine only, with its own failure reasons"
description: "Maintainer go-ahead 2026-11-10 on four assumptions for phase 4: a full session needs engine-side preparation and fails with prepare-unsupported without it (no core-driven loop), three new failureReason values, all-audio as an instance setting, and prepare jobs before live HLS; plus the two choices made while building (media is not served while preparing, a lost prepared session goes back to preparing)."
tags: [core, engine, prepare, phase-4, decision]
generated: { by: "agent/claude", at: "2026-11-10T18:00:00Z" }
code_refs:
  - "packages/core/src/sessions/prepare-jobs.ts"
  - "packages/core/src/engines/engine-module.ts"
  - "packages/api/src/sessions.ts"
status: stable
---

**Decision (maintainer, 2026-11-10: "go with your assumptions").** The four questions [[process/phase-4-core-checklist]] left open were settled as the checklist assumed:

1. **Preparation runs on the engine only.** A `mode: 'full'` session needs an engine with engine-side preparation (Rivulet Engine v0.30.0 or later with `RIVULET_HLS_PREPARE=1`, detected at runtime). On any other engine it fails with `prepare-unsupported`. The core-driven loop in [[architecture/engine-prepare-ahead]] (request every segment and discard it) isn't built.
2. **Preparation has its own failure reasons:** `prepare-unsupported`, `prepare-too-large` (the engine answered `507`) and `prepare-failed` (the engine's job ended `failed` twice). They are new values of `failureReason`, which is a free string in the schema, so the change is additive.
3. **All audio renditions is an instance setting,** `MULTITAP_PREPARE_ALL_AUDIO`, not a field on the create request.
4. **Prepare jobs come before live HLS.**

**Why.** The engine-side job transcodes without moving the file across the LAN (about 4 GB per content-hour otherwise), reports each segment's cache status so verification is exact, pins its segments, and resumes after an engine restart. The only engine Multitap is developed and tested with has it. A second, slower path would need its own verification by response times and its own progress store, for an engine nobody runs. Every other feature still works on an engine without preparation, which is what the hard rule asks.

**Chosen while building, not asked.** Both follow the design's wording and can be changed without breaking `/v1`:

- **A `preparing` session's media isn't served** (`404`, as for `resolving`). A source above `liveMaxHeight` can't be played live anyway, and one status rule is simpler than one per height.
- **A prepared session the engine lost goes back to `preparing`** when a check finds it (`prepare.lost`), and is `ready` again when the new job is done. The alternative, leaving it `ready` and letting the gateway's self-heal transcode live, would stall a source the engine can't transcode in real time.

**Considered and declined.** Reusing `engine-error` for every preparation failure: a client couldn't tell "pick a smaller source" (`prepare-too-large`) from "this engine can't prepare" (`prepare-unsupported`).

Related: [[architecture/engine-prepare-ahead]], [[process/phase-4-core-checklist]], [[process/build-plan]], [[architecture/playback-session]].
