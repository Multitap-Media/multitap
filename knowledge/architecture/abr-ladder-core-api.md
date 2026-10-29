---
type: Architecture
title: "Planned ABR ladder: core side (request, identity, capability, players)"
description: "How core would expose the planned ABR ladder: the ladder form of quality, identity and caps, capability fallback, production policies, cost, codecs, gateway and load, and the open watch-party and devices questions. Nothing here is built."
tags: [core, abr, ladder, planned, quality]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/api/src/sessions.ts"
status: stable
---

Source of truth for core's side of the ABR ladder. **Nothing here is built**, and core is built against a fake-engine ladder until the engine side lands. The engine track and maintainer decisions (2026-10-01) are in [[decision/abr-ladder]] and Planned engine changes; scoping is in [[architecture/engine-abr-ladder-design]] (originally `docs/engine-abr-ladder-scoping.md`). The current one-rendition behaviour is [[architecture/rendition-and-bandwidth]].

- **How players behave.** The player, not the server, decides. It measures segment throughput and switches by fetching the next segment from another rung's playlist, at a segment boundary; its buffer (10–30 s) hides any generation delay. The server sees only ordinary segment requests. Caveat: the generation delay on the first request of a lazily made rung can look like a slow download and bias a player's estimate downward (untested with hls.js). Player settings that help: the start level, `capLevelToPlayerSize`, the EWMA estimate tuning, and locking to one rung.
- **Create request.** `quality` grows a ladder form, additive: `quality: { ladder: [{ height?, bitrate?, codec? }, ...], policy? }`. The existing `maxHeight`/`bitrate` stays for one-rendition sessions. All rungs are listed on the creating request, because the master playlist advertises every rung up front.
- **Identity and caps.** The session's identity (idempotency, the engine session id) includes the effective ladder. `SESSION_MAX_BITRATE` and `liveMaxHeight` apply per rung. `SESSION_BITRATE_BY_HEIGHT` supplies a rung's missing bitrate. `PlaybackSession` reports the applied ladder.
- **Capability.** The engine capability `ladder` is detected at runtime, as `sessionOverrides` is. Without it, a ladder request falls back to one rendition (the top rung) with a logged warning, and the session's `quality` shows what was applied.
- **Rung production policies** (engine default, or per request):
  - *Lazy:* a rung is made only when requested. Cheapest; the first request pays the ffmpeg time (about 1.1–1.4 s per 4 s 1080p segment on QSV, per phase 0).
  - *Hybrid* (recommended default): a rung becomes active when any viewer first requests it, is then produced ahead of the room's leading playhead like the main rung, and is dropped after an idle period.
  - *All:* every segment gets every rung. Switching is instant and predictable, at the full ladder's cost on the whole movie, including rungs nobody watches. For an operator with the hardware.
  - Preparation (`mode: 'full'`, [[architecture/engine-prepare-ahead]]) naturally produces every rung in one pass, with no on-the-fly transcoding.
- **Cost.** By pixel count a 1080p/720p/480p ladder is about 1.65× one 1080p encode. Lazy and hybrid cost about what separate sessions per active rung would, but with aligned segments and one shared session, probe and source read. One decode saves decode work when several rungs are made together.
- **Codecs.** H.264 by default, HEVC wanted (the maintainer expects all clients to decode it). A ladder's codec set must be decodable by every viewer of the room, since a player can't switch to a rung it can't decode, and mixed-codec ladders need player support for switching.
- **Gateway and load.** The gateway serves per-rung media playlists and segment files, so the filename allowlist ([[architecture/media-gateway]], [[architecture/media-gateway]]) needs the rung names. Admission control ([[architecture/engine-session-lifecycle]]) counts active rungs.
- **Watch party (open design question, not decided).** With a ladder, the client could give each viewer ABR (auto) instead of "wait for the slowest". All rungs share one timeline, so sync is unaffected either way. Decide in phase 3.
- **Devices.** Handoff between, say, a phone and a TV (Continuity across devices) is the other case a ladder serves: one session whose rungs suit both, instead of a second session per device. That raises its priority, not its timing ([[process/build-plan]]).

Related: [[architecture/playback-session]], [[concept/engine-descriptor]].
