---
type: Architecture
title: Addon response budget
description: "How core bounds the work an addon response costs, not just its bytes: list responses keep their first items up to a per-resource count, items, metas and manifests past a nesting depth or a key count per object are refused, metas keep their first 20 000 videos, manifests their first 500 catalogs, and a stream description's first 16 lines are read."
tags: [core, addons, security, dos, limits]
generated: { by: "agent/claude-opus-5.5", at: "2026-11-04T02:30:00Z" }
code_refs:
  - "packages/addon-protocol/src/limits.ts"
  - "packages/addon-protocol/src/response.ts"
  - "packages/addon-protocol/src/meta.ts"
  - "packages/addon-protocol/src/manifest.ts"
  - "packages/addon-protocol/src/client.ts"
  - "packages/core/src/selection/parse/extractors.ts"
  - "packages/core/src/lib/ttl-cache.ts"
  - "packages/core/src/library/watched-bitfield.ts"
status: stable
---

Source of truth for the limits core puts on what an addon sends, beyond the response size cap. Added on 2026-11-04 after a review of hostile-addon costs found that one response within the 8 MiB cap could block the event loop (and so every route and the media gateway) for tens of seconds.

## Why bytes are not enough

The addon client caps a response at 8 MiB (`DEFAULT_MAX_BYTES`) and a time limit ([[architecture/addon-private-host-guard]] covers where it may connect). Inside that, the cost of a response depends on its shape:

- **Count:** about 270 000 minimal streams (`{"url":"https://a.io/N"}`) fit in 8 MiB. Each was validated, parsed for release names, ranked and stored.
- **Width:** one object with about 600 000 keys fits too. `looseObject` schemas copy every key, and a stream with no valid source is copied once per source variant tried.
- **Depth:** nesting a million levels deep is valid JSON and parses, but `JSON.stringify` throws `RangeError` on it, so a manifest or stream carrying it could not be stored.
- **Lines:** a 6 KB description of 2 048 short lines made the release-name parser run 2 048 times for one stream.

## The limits

All in `@multitap/addon-protocol` (`limits.ts`), applied while parsing, before the zod schemas see the data:

| What | Limit | Past it |
|---|---|---|
| `metas` (catalog page) | 1 000 items | the rest are left unread, counted in `truncated` |
| `metasDetailed` | 200 items | same |
| `streams` | 1 000 items | same |
| `subtitles` | 500 items | same |
| `addons` (addon catalog) | 1 000 items | same |
| a meta item's `videos` | 20 000 | the rest are left unread |
| a manifest's `catalogs`, `addonCatalogs` | 500 each | the rest are left unread |
| nesting depth of one list item, meta or manifest | 32 | the item is dropped (reported in `dropped`); a meta or manifest fails as invalid |
| keys on one object anywhere in it | 256 | same |

Lists keep the addon's own order (addons sort best first), so the items kept are the ones the addon ranks highest. Each limit is far above what real addons send: a catalog page is about 100 items, a stream list a few hundred, a long-running daily show a few thousand episodes.

In core:

- `releaseLines` reads the first 16 lines of a description (`MAX_DESCRIPTION_LINES`).
- The addon client logs a response that was truncated, with the addon's id and host and the count (never its URL).

## Linear costs behind the limits

The limits bound the input. The code that handles it must also stay linear, so a response at the limits is still cheap:

- `TtlCache` (the stream store, item metas, subtitles, tokens) drops the least recently used entry in O(1) when full. Its scan for expired entries runs at most once per sweep interval (its TTL, at most a minute), not on every write.
- `WatchedBitField` looks a video up through an index built once per video list, and marking a season watched walks the list once to find the resume point.
- A stored watched bitfield inflates to at most 1 MiB (`MAX_BITFIELD_BYTES`), so a crafted field can't decompress into a huge buffer.

## Related

- [[core-review/sec-input-unbounded-memory]]: the count-bounded response cache, which the byte size of responses still drives.
- [[architecture/normalized-addon-types]]: the schemas these limits sit in front of.
