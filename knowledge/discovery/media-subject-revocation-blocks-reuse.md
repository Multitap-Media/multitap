---
type: Discovery
title: "A revoked media token subject can't be re-minted until its tokens would expire"
description: "Found planning phase 3: core denylists a revoked subject until its last token would expire and answers 409 to minting it, and revocation is per core session, so subject = memberId breaks a lifted kick or a re-signed-in device, and the client must record which subjects it minted where."
tags: [media-tokens, revocation, discovery]
generated: { by: agent/mcp, at: "2026-10-09T18:03:12Z" }
status: stable
---

**Finding (2026-10-09, while a watch-party client was planned).**
- Core's rule ([[concept/media-tokens]]): a revoked subject stays on the session's denylist until the latest token minted for it would expire (at least process start + `MEDIA_TOKEN_MAX_TTL_MS` for sessions older than the process), and minting for it meanwhile answers `409`. The denylist is checked on every media request, after the 60 s verified-token cache, so revocation itself is immediate.
- A client that uses `subject = memberId`: a member whose kick is lifted, or a device that signs in again and reuses its device row, couldn't get a token for hours.
- Revocation is per core session; the client must know which subjects it minted in which session (the personal room, every party), so it needs a table for them.
- Proposed fix (not decided): a fresh opaque subject per grant, recorded in a client `media_grants` table (Media grants with one opaque subject per mint, tracked by the client).

Related: [[concept/media-tokens]].
