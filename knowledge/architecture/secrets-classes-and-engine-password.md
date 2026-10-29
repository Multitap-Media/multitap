---
type: Requirement
title: "Secrets: no central holder, the classes, the Secret wrapper and the engine password"
description: "Decided 2026-10-01: no central secrets holder. The five secret classes with direction, storage and lifecycle; the Secret wrapper, one rule for outbound credentials, consistent rotation; and the first use, the write-only engine proxy password (built 2026-10-01, R24)."
tags: [security, secrets, decision, requirement]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:19:10Z" }
code_refs:
  - "packages/core/src/lib/secret.ts"
  - "packages/core/migrations/0006_engine_proxy_password.ts"
status: stable
---

Source of truth for this topic ((second part)).

**No central secrets holder** (decided 2026-10-01). The question was whether
core should keep every secret in one component. It shouldn't, because its
secrets differ in direction and lifecycle:

| Kind | Direction | Stored as | Lifecycle |
|---|---|---|---|
| API keys | inbound: clients present them | a hash in `api_keys`; the plaintext is shown once at creation | never recoverable; replaced by creating a new key and revoking the old one |
| Media token signing key | core's own | `MULTITAP_MEDIA_TOKEN_SECRET` or `MULTITAP_MEDIA_TOKEN_SECRET_FILE`, held in memory | set at deploy time; rotated with `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS` |
| Media tokens | outbound: to players | not stored; derived (signed) on demand | short-lived (`MULTITAP_MEDIA_TOKEN_TTL_MS`); ended by expiry, epoch or the subject denylist ([[concept/media-tokens]]) |
| Outbound credentials: the engine's proxy password now; perhaps addon credentials later | outbound: core → a service | must be stored **recoverably**, since core sends them | set by the operator; rotated when the service's value changes |
| Raw `Stream` objects, `mediaURL`s, manifest URLs | third-party data that carries debrid tokens | secret columns (`addons.manifest_url`, `playback_sessions.stream_json`, `engine_sessions.media_url`) and the in-memory stream store | as long as their addon, source list (`MULTITAP_STREAM_STORE_TTL_MS`) or session; deleted with it |

A single holder would be a component whose job is to hand out plaintext for
every kind, so one weak point exposes all of them, and it would flatten rules
that differ on purpose: a hash that can't be read back, a key that lives only in
the environment, a token that is never stored. Instead:
- **(a) A `Secret` wrapper type.** `toString()`, `toJSON()` and Node's inspect
  give `[redacted]`; the value comes out only through an explicit `reveal()` at
  the point of use. It complements the key-based log redaction above: that
  catches known field names, this catches a secret under any name (an error
  message, a serialized config object, a log field nobody listed). Built in
  `packages/core/src/lib/secret.ts`. It stays `[redacted]` in `debug` and `trace`
  logs too: the unredacted levels show what core sent and received, which
  the plaintext of a credential core holds adds nothing to.
- **(b) One place and one rule for outbound credentials.** Each is a secret
  column on the record it belongs to, held as a `Secret` in memory, never in an
  API view (write-only over the API) and never in logs at `info` and above.
  Encryption at rest, with a key supplied through the environment like
  `MULTITAP_MEDIA_TOKEN_SECRET`, is optional. Decide it once for **all** stored secrets,
  the stream and manifest columns included, when a third kind of outbound
  credential appears (likely the client's Discord or mail credentials, which follow
  the same rule): encrypting one column while the others stay plain buys little.
- **(c) Consistent rotation rules.** Every kind states how it rotates and
  whether there's an overlap: API keys by a second key, then revoking the first;
  the signing key by moving it to `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS` until the
  longest token signed with it has expired (`MULTITAP_MEDIA_TOKEN_MAX_TTL_MS`);
  outbound credentials by updating core's copy when the service's value
  changes.

**First use: the engine password** (built 2026-10-01, R24). The engine
descriptor ([[concept/engine-descriptor]]) has a secret `proxyPassword`, stored in `engines.proxy_password`
(a secret column, migration `0006`) and write-only over `/v1/admin/engines`:
- `PUT` accepts it. A `PUT` **without** the field keeps the stored password (so
  editing a descriptor from a `GET` doesn't wipe it); `""` or `null` clears it.
  Responses carry only `proxyPasswordSet: boolean`. Core's CLI sets it from a
  file instead, so it never appears on a command line:
  `multitap engine proxy-password home --file proxy-password.txt` (`--clear`
  removes it).
- Core reads it for each engine request as a `Secret` and adds it as
  `api_password` only on the way out, to the probe and master requests for a
  `/proxy/stream` `mediaURL`. The stored `mediaURL` doesn't carry it, so a
  changed password applies to the next request without a restart, and it
  isn't in `debug` logs either. (The engine binds a `mediaURL` to a session on
  creation, so a running engine session keeps the password it started with
  until it is recreated.)
- It's never logged: `password`, `proxyPassword`, `proxy_password`,
  `apiPassword` and `api_password` are redaction keys, and the engine `PUT` log
  line records only `proxyPasswordChange: set | kept | cleared`. The engine
  itself logs it with every proxied URI when `STREMIO_HTTP_LOG=1` (Reference engine configuration), up
  to upstream `a038e80`, which adds `api_password` to its redaction list
  ([[process/upstream-engine-asks]]).
- Rotation: set the new value on the engine and in core together; sources that
  fail in between fail their probe (`probe-failed`) with a log hint.

Related: [[architecture/secrets-policy]], [[concept/engine-descriptor]], [[concept/media-tokens]].
