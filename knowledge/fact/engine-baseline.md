---
type: Fact
title: "Engine baseline the design is written against (v0.18.1, 9475695)"
description: "The stremio-server-go commits and versions the design refers to: first review at 9475695, behaviour current as of v0.18.1 (7c637ad), Go 1.27.1 to build, the upstream PRs merged on 2026-09-29/30 and which release carries each; the reference engine runs the build after #36."
tags: [engine, baseline, versions, upstream]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:35:59Z" }
status: stable
---

Source of truth for this topic (migrated from the preamble of the former design document, as of 2026-10-09).

stremio-server-go was first reviewed at `9475695`; the line references in the engine review ([[architecture/engine-hls-model]], [[architecture/engine-endpoints-core-uses]]) are for that commit and drift as upstream moves. The behaviour described is current as of **v0.18.1** (`7c637ad`). Building from source needs Go 1.27.1.

This project's upstream PRs **are all merged**: #24–#29 on 2026-09-29, #33 (the container-aware seek pre-roll from issue #30), the fixes #34 and #35, and #36 on 2026-09-30. Upstream tagged **v0.18.0** (`ec0125c`, #24–#29 and #33) and **v0.18.1** (`7c637ad`, adds #34 and #35); #36 (a Windows CI job) followed on `main` (`11be9eb`), the build the reference engine runs. [[process/engine-upstream-prs]] lists what each adds. Where the design depends on one of these changes, the text names it and gives the behaviour on an engine without it. ffmpeg behaviour found while building them is in the discovery concepts ([[discovery/ffmpeg-mpegts-seek-next-keyframe]], Tone mapping chain needs output primaries on the first zscale).

Later upstream work (#49–#66, 2026-10-15 and 2026-10-16) is tracked in [[process/upstream-engine-asks]].

Related: [[architecture/overview]], Reference engine hardware and measured performance.
