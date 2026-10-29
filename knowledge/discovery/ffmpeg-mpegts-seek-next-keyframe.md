---
type: Discovery
title: ffmpeg input seek on MPEG-TS starts at the next keyframe
description: "With re-encoding, input -ss into MPEG-TS does not snap back to the previous keyframe, so the 10 s pre-roll fails for sources with keyframe intervals longer than about 10 s."
tags: [ffmpeg, mpegts, seek, discovery]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/core/src/engines/"
status: stable
---

Source of truth (#33). Measured with ffmpeg **8.0.1** (Ubuntu 26.04 under WSL2) and **9.0.2** (the gyan.dev full build on Windows), through server-go's real transcode arguments. Unless marked, findings are from 8.0.1, the version most runs used. The reference engine runs the gyan.dev 9.0.2 build; phase 0 re-checked the ones that matter on it (`docs/phases/phase-0-results.md#37-questions`).

**Seeking in MPEG-TS starts at the *next* keyframe.**
- MPEG-TS has no seek index. With re-encoding, an input `-ss` into TS does not snap back to the previous keyframe; decoding begins at the next one.
- Verified with plain `ffmpeg -copyts -ss X -i file.ts`: with keyframes at 1.48/16.48/31.48/46.48 s, `-ss 40` starts at 46.48. The same content remuxed to MKV starts at the target.
- So server-go's 10 s pre-roll only works for TS when the keyframe interval is shorter than about 10 s. With a 15 s interval, unmodified upstream cached segments with 0, 23, 47 and 71 of 96 video frames. Broadcast captures and Blu-ray `.m2ts` remuxes commonly have long intervals.
- Indexed containers (MKV with or without cues, MP4, HEVC 10-bit MKV) were frame-identical at every pre-roll down to 0.

**Handling.** PR #33 (`STREMIO_HLS_SEEK_PREROLL`) shrinks the pre-roll only for Matroska and MP4/MOV, and can only shrink it (0–10 s). MPEG-TS, HLS, FLV, raw and unknown containers keep the full 10 s ([[process/engine-upstream-prs]]). #29 checks video coverage and retries TS once with 30 s.

Related: [[architecture/engine-hls-model]].
