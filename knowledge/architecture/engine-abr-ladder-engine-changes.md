---
type: Architecture
title: "Engine ABR ladder: filter graph, hardware, session, master and persistence changes"
description: "What the ladder changes inside stremio-server-go: the multi-output filter graph, the GPU pipeline shape (D3D11VA to QSV split and vpp_qsv per rung), the silent libx264 fallback hazard, per-request rung overrides and validation, naming, locking, master playlist branch, persistence without bumping the format version."
tags: [abr, ladder, engine, ffmpeg, qsv, architecture]
generated: { by: agent/mcp, at: "2026-10-09T15:22:47Z" }
status: stable
---

Source: the engine ABR ladder scoping write-up (not published), §3–4. Markings: **[code]** read at engine `11be9eb`; **[inferred]** not run. Parent: [[architecture/engine-abr-ladder-design]].

**Filter graph and hardware [inferred, from phase 0's single-rung pipelines].**
- Today: software decode, `split` and a software `scale` per rung, with `h264_qsv` uploading each output. For ≤1080p sources the extra software scales should be small next to software decode, but measure them on the reference engine (E-cores at 95–100% from two live sessions).
- GPU pipeline (after GPU decoding, phase 0's choice): SDR is D3D11VA decode → `hwmap` to QSV → `split` → `vpp_qsv` per rung (`scale_mode=low_power`) → `h264_qsv` per rung, all on the GPU. HDR10 and DV 8.1: tone-map once before the split, at the top rung's size, then software `scale` for lower rungs (or `hwupload` and `vpp_qsv` per rung). DV profile 5: libplacebo before the split.
- Hardware limits: Intel QSV has no driver cap on concurrent encodes; the limit is throughput. Phase 0 measured 3 concurrent 4K SDR transcodes at about 100% of the engine. A 1080p+720p+480p ladder is about 1.65× one 1080p encode.
- Not known yet (the reference engine host only; QSV cannot run on the dev machine): N `h264_qsv` encoders in one process on Windows oneVPL; `split` of QSV surfaces into several `vpp_qsv` instances (surface pool sizing); real per-segment times for 2 and 3 rungs.

**The silent fallback becomes dangerous [code].** The silent libx264 fallback would turn one failed QSV run into N software encodes on 8 E-cores, well past real time. Options: fall back only for the top rung, or fail the run so the player's ABR steps down. Maintainer question. Upstream wants the single-rung fallback silent, and that must not change.

**Timeout and slots [code].** `SegmentTimeout` applies per run; a ladder run needs it scaled by rung count, or its own knob. A ladder run holds one slot today but does N encodes; options are weighted slot accounting (a 3-rung run can starve behind single-rung runs) or a separate encode budget. Admission on core's side must count a ladder session as heavier.

**Request shape [inferred].** One master query parameter at creation, for example `rungs=1080:6M,720:3M,480:1.5M`, or a JSON or repeated parameter (the per-rung codec and optional fields fit better in JSON). Behind the session-override gate or its own gate (`STREMIO_HLS_LADDER`). Validated like the existing session overrides: a count cap (say six), heights in range, bitrates within the max, distinct heights (two rungs of one height need distinct bitrates or codecs). Invalid gives 400. Frozen in the session config like every other quality knob, so it is part of identity. Rungs replace `maxHeight` and `bitrate`; reject or ignore the combination. Rungs at or above the source height collapse into one source-size rung (the engine never upscales). If everything collapses, it is a single-variant ladder. A source with no video ignores the ladder.

**Naming and locking [inferred].** `HLSFile` uses a flat namespace, so rung files are `r<i>.m3u8` and `r<i>seg<n>.ts`, which do not collide with today's prefixes. The `.ts` dispatch gains a third branch. One lock per segment index for ladder runs, with per-filename locks kept for installs. The run checks which rung files exist and builds the graph for missing ones only. Segcheck and install already work per filename, so a suspicious rung is served provisionally while clean ones are cached; the longer pre-roll retry re-runs only failed rungs.

**Master playlist [inferred].** One `EXT-X-STREAM-INF` per rung: `BANDWIDTH` as the honest peak (maxrate plus audio; the ladder path only, so today's maxrate/2 stays for the default), `AVERAGE-BANDWIDTH`, `RESOLUTION=WxH` (needed for hls.js `capLevelToPlayerSize`), per-rung `CODECS` with the level, optional `FRAME-RATE` (the probe does not keep it today), `AUDIO="aud"` and `SUBTITLES="subs"` as today. Variant order matters because hls.js starts on the first variant unless `startLevel` is set. The single-variant output must stay byte-identical; existing golden tests guard it.

**Persistence [inferred].** Add `Rungs` to the persisted config with `omitempty`. Append `rungs=…` to the output fingerprint only when present, the same pattern as the pre-roll. Do not bump the session format version, which would discard every persisted single-rung session. Validate restored rungs as untrusted input.

**Sync [inferred].** All rungs share one timeline (same indexes, EXTINF and PTS), so the client's clock, drift correction and seek flow do not change. The gain is in buffering: a weak viewer steps down a rung instead of pausing the room. Seek latency under contention improves, because viewers on different rungs wait on one run.

Related: [[architecture/engine-hls-model]], Decision.
