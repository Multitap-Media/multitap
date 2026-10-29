---
type: Architecture
title: "Engine ABR ladder: one decode, many encodes (scoping, design)"
description: "Scoping of an upstream ABR ladder for stremio-server-go: why one per-segment ffmpeg run can decode once and emit every rung, why long-running ffmpeg is rejected for live, where chunked runs belong (preparation), the maintainer's 2026-10-01 direction, per-request rungs and the three production policies."
tags: [abr, ladder, engine, architecture, scoping]
generated: { by: agent/mcp, at: "2026-10-09T15:24:16Z" }
status: stable
---

Source: the engine ABR ladder scoping write-up, not published (code references at engine commit `11be9eb`, v0.18.1 plus #36). Legend from the source: **[code]** read in the code at that commit; **[inferred]** reasoned, not run; **[maintainer]** a decision; **[untested]** nobody has run it. Nothing was run against ffmpeg or QSV.

**Summary.**
- The ladder fits the per-segment model. One ffmpeg run per segment index can decode once, `split` the video and write one `.ts` per rung. Each rung starts on the same frame, so keyframes and boundaries line up after seeks too.
- Preparation is where a longer-running ffmpeg pays off: a chunked run (segments n…n+k in one process) removes per-segment start-up, pre-roll and the range requests against debrid hosts. It belongs with engine-side preparation, already first on the engine track.
- The default output can stay byte-identical. The ladder is a new, gated session shape with its own file names.
- Size: L overall, in 3–4 PRs. Open an issue for discussion first, as with #30.

**Today's segment model [code].** One ffmpeg run per 4 s segment on demand (`segDur = 4.0`). No long-running ffmpeg and no transcode head. Playlists are full VOD playlists. Seeks are requests for a different `seg<n>.ts`. Hybrid seek: input `-ss start-preRoll`, then output `-ss`. Software decode always. `-map 0:v:0? -map 0:a:0?`. Each run starts a fresh encoder, so each segment opens with an IDR. Audio is AAC with `aresample=async=1:first_pts=0,apad`. Output is MPEG-TS with `-output_ts_offset` and `-mpegts_copyts 1`, so segments sit on the source timeline. A per-filename mutex dedupes concurrent requests; a process-wide slot counter bounds runs; output goes to a temp name and then segcheck decides whether to cache. Hardware encode first, with a silent libx264 fallback. The request context drives ffmpeg, so a disconnect kills the run. The master playlist has one `EXT-X-STREAM-INF` with `BANDWIDTH` and `CODECS` and no `RESOLUTION`.

**One decode, many encodes [inferred].** A ladder run for segment n is today's run with a `filter_complex` and one output per rung: `split` after the trim, a `scale` per rung, and `h264_qsv` per output. Alignment comes free because every rung's segment n is cut from the same decoded frames with the same trim and offset.
- Audio: a filter output can feed one output only, and ffmpeg does not share one encode across outputs. Suggested option 1: demuxed audio for every ladder session (the existing `a<k>seg<n>.ts` group, even for single-audio sources), so audio is byte-identical across rung switches and encoded once. Option 2: muxed audio per rung, N identical encodes, unverified as identical.
- Single decode is an efficiency choice, not a correctness one. Under one lock per index, produce only the missing rungs.
- Trim before `split`, so the pre-roll is not scaled N times.

**Why not a long-running ffmpeg for live [inferred].** Every seek outside the produced range would kill and restart the whole ladder, losing work for every viewer. The process runs ahead without a consumer (no portable SIGSTOP on Windows; needs `-readrate` or a pipe). It needs forced keyframes (`-force_key_frames`, `-forced_idr 1` on QSV). It must count as in-flight for eviction. It is not restored on restart.

**Preparation: the chunked run [inferred].** One ffmpeg for segments n…n+k-1 and all rungs, with the segment muxer per rung, forced IDR every 4 s, then segcheck and install per file. `k = 1` is the existing per-segment run. It drops per-segment start-up and pre-roll, and the ~6 range requests per segment (~2.5 s on debrid hosts). Open point: segments from chunked and per-segment runs must be interchangeable in one playlist (AAC priming and `apad` behave differently in a continuous encode). Needs a real-ffmpeg check with hls.js across the seam.

**Costs [inferred].** Disk is the sum of rung bitrates (6M+3M+1.5M is about 4.7 GB per content-hour, against about 4.3 GB at 10M). Eager rungs in a live run cost wasted encodes for nobody watching. A failure (disconnect, hardware error) kills or redoes every rung in the run.

**Maintainer direction, 2026-10-01 [maintainer].**
- An engine-side ladder is wanted and assumed accepted upstream. It sits on the engine track before phase 4, after engine-side preparation.
- Core is built first against a fake-engine ladder, behind an engine capability `ladder`, detected like `sessionOverrides`. An engine without it keeps one rendition.
- One room timeline: boundaries and keyframes line up across rungs, so a rung switch never affects party sync (which follows playhead position).
- **Per-request rungs.** Chosen per request, because operator hardware and internet decide. Core passes the list on the master request that creates the session. Each rung is `{ height?, bitrate?, codec? }`, all optional: height only (bitrate derived from `MULTITAP_SESSION_BITRATE_BY_HEIGHT`), bitrate only (same resolution, different BANDWIDTH), both; codec defaults to H.264. The creating request lists all rungs, and the master advertises every one up front, since players can only choose among advertised variants.
- **Three production policies**, an engine default and a per-request choice: *lazy* (a rung is made only when requested; the first request pays about 1.1–1.4 s per 4 s 1080p segment on QSV), *hybrid* (**recommended default**: a rung becomes active on first request, is produced ahead of the leading playhead, and is dropped after idle), and *all* (every segment gets every rung; instant switching, full cost). Preparation produces every rung in one pass with chunked runs.

**Consequences for core [maintainer, plan].** `quality.ladder` on session create (additive). The session identity includes the effective ladder. `MULTITAP_SESSION_MAX_BITRATE` and `liveMaxHeight` apply per rung. The `ladder` capability is detected at runtime. The gateway serves per-rung playlists and segments, so the allowlist needs rung names. Admission counts active rungs. `PlaybackSession` reports the applied ladder. The watch-party question (give each viewer ABR instead of waiting for the slowest) is open for phase 3. Continuity across devices is a second reason: one session must suit a phone and a TV.

Related: [[decision/abr-ladder]], [[architecture/engine-abr-ladder-engine-changes]], [[process/engine-abr-ladder-phasing-and-risks]], [[architecture/rendition-and-bandwidth]].
