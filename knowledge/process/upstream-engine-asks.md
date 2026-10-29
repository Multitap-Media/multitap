---
type: Process
title: Upstream asks for stremio-server-go and maintainer answers
description: "The engine asks tracked in upstream issue M0Rf30/stremio-server-go#43: merged items, maintainer answers from 2026-10-05, the 2026-10-13 re-check, the 2026-10-15 and 2026-10-16 reviews (#49–#53 and #57–#61 merged; #54 changes requested; post-merge nits), and the open asks in priority order."
tags: [engine, upstream, issue-43, process]
generated: { by: agent/claude-sonnet-5.5, at: "2026-10-17T02:50:00Z" }
status: stable
---

Source: the former design document; AGENTS.md "Open work". Tracker: M0Rf30/stremio-server-go#43 (posted 2026-10-05; closed by the maintainer 2026-10-09 with "feel free to re-open"; checklist posted 2026-10-13 with a request to re-open; re-opened since. The checklist comment was updated 2026-10-16 against `efa1b78`: items 1–5 done, plus a "related" list of #54, #66, #63, #64, #65 and #48). Check the issue and the maintainer's answers before starting a branch, and keep its checklist current.

**Maintainer answers (2026-10-05):** item 5 (api_password redaction) fixed upstream in `a038e80`. Small items 1–4 fine as described, with the private-host allowlist checked at dial time, and keep `BANDWIDTH` legacy strings without a knob. Medium items 6–9 welcome; preparation and transcode-ahead share one low-priority scheduler. Hardware decode accepted (off by default, per codec, software fallback). ABR ladder accepted as a new session shape behind a setting, design issue first. **Remux stays on the fork.** Event stream later. Order: small fixes, preparation, hardware decode, ladder. One area per PR.

**Re-check against upstream `b85b668` (2026-10-13):**
- Item 3 narrowed: `99c265a` added `STREMIO_PROXY_PRIVATE_ALLOW` for `/proxy` and `/extractor`; the HLS path (`mediaURL`) still refused private hosts. Done since as a separate `STREMIO_HLS_PRIVATE_ALLOW` (#49).
- Item 6 constraint: `c18ed7e`/`3c9b19e` cap each session's segment cache (`STREMIO_HLS_SEGMENT_CACHE_BYTES`, default ~300 segments, LRU). Preparation must pin its segments or refuse a session that can't fit.
- Item 8 can build on the new `slotsem` FIFO semaphore.
- Item 14 added: probe-cache bypass/refresh (R33); reproduction before code. `5128a84` (probe singleflight) may be related.
- Our side, not asks: reference engine sets `STREMIO_HLS_SEGMENT_CACHE_BYTES=-1` once on a build with it; core treats `503` + `Retry-After` from `/create` (`STREMIO_MAX_ENGINES`) as `engine-busy` (built 2026-10-14); `STREMIO_ALLOWED_HOSTS` doesn't affect core (IP literal).
- Phase 3 (rooms, sync, handoff) adds no engine asks.

**Merged:** #24 to #29, #33, #34, #35, #36, plus local-files addon #31 and #32 by another contributor. On upstream `main`, not yet released: #50–#53 (2026-10-15); #49 and #57–#61 (2026-10-16, upstream `efa1b78`). Squash merges, each identical to our PR head.

**Review (2026-10-15):** merged #50 (`BANDWIDTH` = maxrate + audio), #51 (relayed playlists resolve against the post-redirect URL), #52 (short-segment check) and #53 (`502`/`504` with a reason on source failure). Changes requested on #49 (separate `STREMIO_HLS_PRIVATE_ALLOW`, applied in `validateRemoteURL` and `validatePersistedURL` too) and #54 (fail-closed `encoding/xml` prolog walk, case-insensitive match, 512-byte peek with a deeper read only for XML). Issue #48 confirmed.

**Review (2026-10-16):** merged #49 (reworked as asked), #57 (#52's tests and comments), #58 (#53's wording, spec, README), #59 (`parseDecimalBitrate` for the audio term), #60 (cert API off the live network; closes #48) and #61 (the truncated-body test accepts either failure reason). Post-merge nits, each a small follow-up PR: #59, README lines 201–209 still need a rewrap (the long line is 207, 111 columns); #60, count requests on the cert stub so a removed redirect fails instead of going live, and keep `/yt/dQw4w9WgXcQ` tests (`security_headers_test.go`, `more_test.go`) from spawning a real yt-dlp; #61, loosen `TestMediaRelayAbortsOnTruncatedUpstream` (`p2_media_fixes_test.go:199`) the same way. Unanswered on #59: should a decimal `STREMIO_TRANSCODE_MAXRATE` (`8.5M`, parsed as 0 today) parse too, and does a decimal equal to the default still count as unconfigured? **Changes requested** again on #54: an all-whitespace (or BOM plus whitespace) 512-byte peek makes `looksLikeXML` false, so the deep sniff never runs, while ffmpeg's `dash_probe` still finds `<MPD` behind 600 spaces. Treat it as XML-looking, and add sp(600)+root, BOM+sp(600) and sp(20000)+root tests. Also drop the gzip/deflate handling from #54 into its own PR. If kept, a failing inflater turns non-200s into `415`, and `Content-Range`/`206` survive decoding.

**Issue #65 (filed 2026-10-16; no PR until the maintainer picks a direction):** (1) A `mediaURL` on the server's own origin skips the relay: `isSelfOrigin` exempts it and `relayInput` hands it to ffmpeg directly with `http,https,tcp,tls,crypto`. `/proxy/stream?d=` then serves a remote playlist or MPD that the relay never sees, and ffmpeg fetches its entries unguarded (`/yt` redirects too, lower risk). It's closed for callers without the password when `STREMIO_PROXY_PASSWORD` is set. Options offered: relay self-origin `/proxy`, `/extractor` and `/yt` URLs, refuse them as media URLs, or document it. Core's side (not adding `api_password` to addon-supplied URLs, refusing self-origin or loopback stream URLs) is handled separately. (2) A decimal `STREMIO_TRANSCODE_MAXRATE`, `_VIDEO_BITRATE` or `_BUFSIZE` (`8.5M`) passes `envBitrate`, but `parseFFmpegBitrate` returns 0. `BANDWIDTH` falls back to `4000000`, and restore discards every persisted session as "invalid config". Verified with a throwaway test on `efa1b78`. Asked: does a decimal equal to the default count as unconfigured, and should restore accept whatever `envBitrate` accepts? The reference engine must use integer bitrates until this is fixed.

Still true: stage engine paths explicitly, never `git add -A`; `GOOS=android go vet` fails on upstream `main` itself.

**Open asks, in order:**
1. Short-segment check for #29 (item 1). Done: #52, #57.
2. A distinguishable status when a source fails mid-stream (item 2). Done: #53, #58. Core's gateway retries a segment 502/504 once, and a 404 once for known-good sessions (2026-10-14).
3. Private-host allowlist for HLS `mediaURL`s (item 3). Done: `STREMIO_HLS_PRIVATE_ALLOW` (#49); `/proxy` has upstream's `STREMIO_PROXY_PRIVATE_ALLOW`.
4. `BANDWIDTH` reflects the real peak (item 4). Done: #50, #59; README rewrap pending.
5. Header/index cache for HTTP sources (item 7).
6. **Engine-side preparation, `POST /hlsv2/{id}/prepare` with per-segment cache status, pinned against the cache cap. The one ask phase 4 needs.**
7. Transcode-ahead window (item 8).
8. YouTube through DASH formats (item 9).
9. Hardware decode (item 10, accepted). Hardware tone mapping also an ask.
10. ABR ladder (item 11, accepted; design issue first).
11. Remux (item 12; keep on fork).
12. An event stream from the engine (item 13; low priority).
13. Probe-cache bypass or TTL (item 14; R33; evidence first).

Not an ask, our own fix: #54, the relay refusing DASH manifests it can't rule out. Reworked and pushed 2026-10-16 as `9acd08e`: a whitespace-only peek gets the 16 KiB walk, the compression code is dropped, and the UTF-16/32 decoding is dropped, because `dash_probe`'s `av_stristr` stops at a NUL and `ff_dash_demuxer` declares no extension or MIME type. A NUL with no `<MPD` exempts binary slices; `<MPD` is checked first, and any other control byte gets no exemption. It awaits review. Follow-up: [#66](https://github.com/M0Rf30/stremio-server-go/pull/66) (2026-10-16) decodes gzip/deflate the way ffmpeg does, and is stacked on #54 (merge after it). It sends `Accept-Encoding: identity` and decodes only 2xx; errors pass through untouched. An undecodable 2xx, or a 206 not starting at byte 0, gets `502`, recorded as a source failure. A 206 from byte 0 is decoded into a `200` without `Content-Range`, `Content-Length` or `Accept-Ranges`. Until it lands, a manifest gzipped despite `Range` reaches the sniff compressed.

The full ask table with reasons and per-ask status: [[process/upstream-engine-asks-table]].

Related: [[process/engine-upstream-prs]], [[decision/abr-ladder]], Engine changes go upstream first; fork only if upstream declines.
