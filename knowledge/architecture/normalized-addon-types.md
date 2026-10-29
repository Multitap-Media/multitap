---
type: Component
title: "Normalized addon types (packages/api): SourceCandidate and friends"
description: "The normalized types clients see instead of raw addon data: CatalogRef, MetaPreview, MetaDetail and SourceCandidate with its parsed fields, playable flags and unplayable reasons; raw Stream objects stay in core."
tags: [core, core-api, addons, types]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T01:46:11Z" }
code_refs:
  - "packages/api/src/browse.ts"
  - "packages/api/src/selection.ts"
  - "packages/core/src/selection/candidates.ts"
status: stable
---

Source of truth , in `packages/api`.

```ts
CatalogRef     { addonId, type, id, name, extraSupported[] }
MetaPreview    { type, id, name, poster, year?, … }
MetaDetail     { …, videos?: Episode[], links, trailers }
SourceCandidate {
  key: string                // core-side lookup to the raw Stream
  addonName: string
  kind: 'torrent' | 'http' | 'youtube' | 'live' | 'external' | 'engine-local'
  title: string
  parsed: { height?, hdr?: 'hdr10'|'hdr10+'|'dv'|'hlg', dvProfile?, codec?, bitDepth?,
            audio?, sizeBytes?, seeders?, cached?: boolean }
  requiresEngine?: string    // engine affinity (local content, okf:architecture/future-remote-engines)
  score: number                        // okf:concept/source-ranking
  playable: boolean
  unplayableReason?: 'external' | 'dv5' | 'other-engine' | 'too-high' | 'unsupported'
  playableWhen?: 'live' | 'prepared'   // e.g. 4K on the reference engine
  // also: addonId, name (the stream's short label); parsed also carries
  // container, source (bluray/web/cam…), languages, durationSec
}
```

Clients only ever see `SourceCandidate`s. Raw `Stream` objects stay in core. stremio-core's `StreamSource` also has archive (`Rar`, `Zip`, `Zip7`, `Tgz`, `Tar`), `Nzb` and `PlayerFrame` variants; they're parsed and listed with `unplayableReason: 'unsupported'` until the engine module handles them ([[architecture/engine-prepare-stream]], [[architecture/engine-module]]).

Related: [[concept/source-ranking]], [[architecture/last-source-per-item]], [[architecture/core-v1-api]].
