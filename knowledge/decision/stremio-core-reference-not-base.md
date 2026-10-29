---
type: Decision
title: "stremio-core is a reference for types and rules, not a dependency"
description: "Core is written in TypeScript; stremio-core (Rust) supplies protocol types and library-item rules only, because shimming its WASM build costs more than the code it would save."
tags: [stremio-core, decision, dependencies]
generated: { by: agent/mcp, at: "2026-10-09T15:10:11Z" }
status: stable
---

**Decision.** stremio-core is a reference, not a base. It is not a dependency.

**Why not use it.**
- It does not cover what is hard here: it does not rank or choose streams, does not decide on HLS or transcoding (that lives in stremio-video), and the gateway, preparation and multiple engines would still be ours.
- Its multiplicity does not match: one runtime per user profile, while core serves many profiles and many concurrent sessions.
- Language: it is Rust behind an `Env` trait. Using it from Node means shimming the browser WASM build or writing a native Env plus FFI. For a one-person build a second toolchain costs more than the ~2k lines of TypeScript it would save.

**What we take from it.**
- Its types are the schema source of truth for `packages/addon-protocol` (Manifest, Stream, MetaItem, behaviorHints, id formats, legacy addon transport quirks).
- Its library item format and rules for profiles (progress saving, watched-episode bitfield, watched thresholds, next-episode choice).

Reference clones (`stremio-core`, read-only, git-ignored) are for reading only.

Sources: [[architecture/overview]] "stremio-core is a reference, not a base"; AGENTS.md "Repository layout".
Related: [[architecture/library-and-profiles]].
