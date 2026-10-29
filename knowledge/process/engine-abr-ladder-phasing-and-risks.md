---
type: Process
title: "Engine ABR ladder: open questions, phasing, size and risks"
description: "The eight questions for the upstream maintainer, the L size estimate in 3–4 PRs with the issue-first phasing, the core-side work, the risks (maintainer appetite, untested QSV multi-encode, CPU headroom, the silent fallback, mixed chunked segments, ABR oscillation), and the HEVC and ABR-player notes that are still untested."
tags: [abr, ladder, phasing, risks, process]
generated: { by: agent/mcp, at: "2026-10-09T15:22:47Z" }
status: stable
---

Source: the engine ABR ladder scoping write-up (not published), §5 and §6.3–6.7. Parent: [[architecture/engine-abr-ladder-design]].

**Questions for the maintainer.**
1. Is a ladder wanted upstream at all, and under #25's override gate or its own (`STREMIO_HLS_LADDER`)?
2. Request syntax (compact list or JSON) and per-rung fields (height only or width too; bitrate, maxrate, bufsize).
3. Make every rung eagerly in a live run, or only requested ones (or a knob)? The maintainer's policies answer this with lazy, hybrid and all.
4. Audio for ladder sessions: always demuxed (rendition group), or muxed per rung?
5. What the libx264 fallback does for a ladder run, and whether timeout and slot cost scale with rung count.
6. `BANDWIDTH` as peak for ladder variants, which diverges from the default's maxrate/2.
7. Preparation: can chunked runs with forced IDRs share a playlist with per-segment ones, or is a prepared session prepared-only?
8. Variant order, and whether to expose `FRAME-RATE` (needs a probe field).

Open question: how a request names the policy (`lazy`, `hybrid`, `all`), and whether the default is per engine or per request.

**Size.** L overall, in 3–4 upstream PRs, plus core-side work [inferred].

**Phasing.**
0. Issue first: describe the shape, the defaults guarantee and the questions; get direction before code, as with #30.
1. PR 1 (M): ladder sessions on the per-segment model. The `rungs` override with parsing and validation; per-rung playlists and names; the master ladder branch; the multi-output `filter_complex` run for missing rungs; per-index lock; per-output segcheck and install; demuxed audio; persistence fields and fingerprint suffix; software `split` and `scale` with the existing encoders. Tests: argv goldens, master goldens, persistence round-trip, override validation, lock behaviour, all offline without ffmpeg. Real-ffmpeg checks outside the repo: frame alignment across rungs, and hls.js switching mid-stream.
2. PR 2 (M): engine-side preparation (`POST /hlsv2/{id}/prepare`), ladder-aware from the start. First as a per-index walk; then the chunked multi-segment run, once the interchangeability check passes.
3. PR 3 (M–L): GPU decoding with the ladder graph (D3D11VA to QSV split and `vpp_qsv` per rung, tone map once at the top rung). It can come before PR 1, so the ladder builds on hardware frames from the start.
4. PR 4 (S, optional): weighted slot accounting and the transcode-ahead window across rungs.

**Core side (this repo).** `quality.ladder` on create, mapped to `rungs`, with rungs derived from `MULTITAP_SESSION_BITRATE_BY_HEIGHT`; a `ladder` capability with feature detection; admission weighting; the session identity includes the ladder.

**Risks.**
- Maintainer appetite: a large, cross-cutting change to `hls.go`. Mitigation: issue first, strict gating, byte-identical defaults.
- QSV multi-encoder behaviour in one process on Windows is unverified. Every PR's testing notes must say QSV was not exercised on the dev machine.
- CPU headroom on the reference engine host with software decode plus N scales. Live ladders may be practical only for ≤1080p sources until GPU decoding lands.
- A silent libx264 fallback multiplied by N can push the box far past real time, silently.
- Mixing chunked and per-segment segments (AAC priming, `apad`) may cause audible seams or hls.js gaps. Untested.
- ABR players: hls.js across resolution switches on MPEG-TS should be fine (each segment carries SPS/PPS and starts with an IDR), but Safari's native player and hls.js both need checking. A wrong `BANDWIDTH` makes ABR oscillate.
- Disk and wasted encodes for rungs nobody watches, in eager mode.
- GOP assumption: `videoGOP = 120` assumes 30 fps. A chunked run must use time-based forced keyframes, not `-g`.

**Untested notes.**
- HEVC: `hevc_qsv` on the reference engine host is untried; its speed and quality at the home presets are unmeasured. AV1 encode is likely unavailable on that iGPU (AV1 decode only), so not planned. A mixed-codec ladder needs player support for switching, and a player cannot switch to a rung it cannot decode, so the ladder's codec set must be decodable by every viewer in the room. HEVC inside MPEG-TS is less widely played than HEVC in fMP4; whether `.ts` output is enough for the maintainer's clients needs a check before HEVC rungs are promised.
- ABR behaviour: the player decides, from segment throughput. A lazily made rung's first-request delay may bias the estimate downward (untested with hls.js). Player settings that help: `startLevel`, `capLevelToPlayerSize` (needs `RESOLUTION`), EWMA tuning, locking to one rung.

**Priority.** Continuity across devices raised the ladder's priority; its timing (before phase 4) is unchanged ([[process/build-plan]]).

Related: [[decision/abr-ladder]], [[process/upstream-engine-asks]].
