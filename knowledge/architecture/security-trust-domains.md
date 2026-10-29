---
type: Architecture
title: "Security principles and trust domains"
description: "Multitap's trust domains (hostile addons, a public media listener, API key holders trusted within their scope, an unauthenticated engine, non-expert operators) and the rule that the API reveals nothing to a caller without a key."
tags: [architecture, security, threat-model]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
code_refs:
  - "SECURITY.md"
  - "packages/core/src/http/app.ts"
---

The threat model in `SECURITY.md` rests on these domains:

- **Addons are hostile.** Anyone with an admin key may install any addon URL, so manifests, catalogs, metas, streams and subtitles are attacker-controlled: their size, timing, shape, text and the URLs in them. Requests Multitap makes on an addon's behalf are guarded against private hosts ([[architecture/addon-private-host-guard]]), and addon text is bounded and parsed with linear regexes ([[concept/addon-aggregation]]).
- **The media listener faces the internet.** A media token holder is a browser, not a trusted client: a token opens one session's media until it expires or is revoked ([[concept/media-tokens]], [[architecture/media-gateway-proxy]]).
- **API key holders are trusted clients within their scope** (`read`, `client`, `admin`, `metrics`). A key with fewer scopes must not be able to do more ([[architecture/core-api-keys-security]]).
- **The engine has no authentication.** Only Multitap may reach it, and Multitap must not let anyone steer it beyond what the design allows ([[architecture/engine-security-posture]]).
- **Operators are not security experts.** Unsafe defaults and silent misconfiguration count as vulnerabilities; Multitap warns about a public plain-HTTP API ([[architecture/network-and-deployment-exposure]]).

**No landing page.** Without a valid key, every API route, including the OpenAPI document, answers the same `404` as an unknown path, and an unlisted method gets the same `404`, so a scan learns nothing. Only `/healthz` answers without a key.

**Secrets** never leave through responses, events, error details, metrics labels or logs at `info` and above ([[architecture/secrets-policy]], [[architecture/secrets-classes-and-engine-password]]).

Related: [[architecture/goals-and-non-goals]], [[core-review/summary]].
