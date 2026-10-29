---
type: Architecture
title: "Configuration: what a setting is, and core's environment variables"
description: "What counts as a setting (env for startup limits, database for runtime preferences, code for protocol facts) and the full table of core's configuration (read by docs:check against EnvSchema)."
tags: [configuration, env, settings, core, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:36:25Z" }
code_refs:
  - "packages/core/src/config.ts"
status: stable
---

Source of truth for this topic and its setting rules. `pnpm run docs:check` reads this concept: every variable in core's `EnvSchema` (`packages/core/src/config.ts`) must appear in the table below. The engine's own settings are in [[architecture/engine-private-host-allowlist]] and [[concept/engine-descriptor]].

## Core

Every variable but `NODE_ENV` carries the `MULTITAP_` prefix, core's public name ([[decision/core-public-name-multitap]]); the unprefixed names of `core-v0.1.4` and earlier are not read. Every variable is validated at startup (`packages/core/src/config.ts`); an invalid one stops core with one line per problem, and secrets are never echoed. Every `_MS` variable is an integer number of milliseconds: the table shows defaults in readable units (`8h` is `28800000`). Unset and empty both mean the default.

| Setting | Default (or example) | Purpose |
|---|---|---|
| `MULTITAP_API_PORT` / `MULTITAP_MEDIA_PORT` | `8080` / `8081` | `/v1` and `/media` listeners; each private or public ([[architecture/network-and-deployment-exposure]]). They must differ. |
| `MULTITAP_API_BIND` / `MULTITAP_MEDIA_BIND` | unset (all interfaces) | Address each listener binds (an IP or host name), TLS included: e.g. `127.0.0.1` or an internal interface for the API on a bare host. The API listener must never be reachable from outside ([[architecture/network-and-deployment-exposure]]). In Docker leave them unset: isolation comes from the networks and from not publishing `8080`. Core warns at startup when the API listener isn't on loopback and has no TLS. |
| `MULTITAP_CORS_ORIGINS` | e.g. `https://app.example.com` | Browser origins allowed to call core (comma-separated, exact, no path or trailing slash); empty = no CORS headers |
| `MULTITAP_TLS_CERT_FILE` / `MULTITAP_TLS_KEY_FILE` | unset | Core terminates TLS itself on both listeners (omit behind a TLS proxy); set both or neither. Basic support, mainly for self-signed certificates: no ACME. `SIGHUP` re-reads the files without a restart, for an external tool that renews them (Linux and Docker; on Windows, restart). |
| `MULTITAP_DATA_DIR` | `./data` (`/data` in the image) | SQLite |
| `MULTITAP_LOG_LEVEL` | `info` | `fatal` … `trace`, `silent`. At `debug` and `trace` nothing is redacted ([[architecture/secrets-policy]]), and that includes the log files. |
| `MULTITAP_LOG_DIR` | unset (stdout only) | Also write JSON logs to `multitap.<date>.<n>.log` files in this directory (created if missing), through [pino-roll](https://github.com/mcollina/pino-roll): a new file daily and whenever one reaches `MULTITAP_LOG_FILE_MAX_SIZE`. Redaction is the same as on stdout. |
| `MULTITAP_LOG_STDOUT` | `true` | Keep logging to stdout too; `false` needs `MULTITAP_LOG_DIR` |
| `MULTITAP_LOG_FILE_KEEP` / `MULTITAP_LOG_FILE_MAX_SIZE` | `7` / `50M` | Rotated files kept besides the current one (older ones, from earlier runs too, are removed on rotation); size at which a file rotates (`512k`, `50M`, `1G`; 1M–10G) |
| `MULTITAP_BACKUP_DIR` | `<MULTITAP_DATA_DIR>/backups` | Where `/v1/admin/backups` writes database backups ([[architecture/core-persistence]]). Backups contain secrets: treat the directory as secret. |
| `MULTITAP_BACKUP_INTERVAL_MS` | `0` (off) | Back up on a timer, e.g. `86400000` for daily; otherwise at least 60 s. Scheduled and manual backups share `MULTITAP_BACKUP_KEEP`. |
| `MULTITAP_BACKUP_KEEP` | `7` | Backups kept, scheduled and manual alike; the oldest are pruned after a successful backup |
| `NODE_ENV` | `production` | `development` gives pretty logs and the `/dev` page |
| `MULTITAP_MEDIA_TOKEN_SECRET` / `MULTITAP_MEDIA_TOKEN_SECRET_FILE` | unset; 32+ random bytes | Signing key for media tokens ([[concept/media-tokens]]), set directly or read from a file (a Docker secret; one trailing newline is dropped), not both; unset = a random key per process, with a warning |
| `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS` | unset | The old key, still accepted for verification while rotating; needs a current secret |
| `MULTITAP_MEDIA_PUBLIC_BASE` | e.g. `https://media.example.com` | Absolute `mediaUrl` in token responses; required when the media listener is public (core warns at startup when CORS is on and it's unset) |
| `MULTITAP_MEDIA_TOKEN_TTL_MS` / `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS` | `8h` / `7d` | Default (1 min–7 d) and longest (up to 30 d) media token lifetime ([[concept/media-tokens]]); the default may not exceed the longest |
| engines | `/v1/admin` → `engines` table | None is seeded (since 2026-10-20): add one with `PUT /v1/admin/engines/{id}` ([[concept/engine-descriptor]]). The engine's `proxyPassword` is write-only ([[architecture/secrets-classes-and-engine-password]]), set there or with the CLI |
| addons | `/v1/admin` → `addons` table | Manifest URLs (secret) |
| `prepare.leadTime.upTo1080` / `.above1080` | `1h` / `36h` | [[architecture/engine-prepare-ahead]]; phase 4, not a setting yet |
| `MULTITAP_RETENTION_IDLE_MS` (`retention.idle`) | `1h` | [[architecture/engine-retention]] (enforced with #24's `DELETE`) |
| `MULTITAP_SESSION_RELEASED_KEEP_MS` / `MULTITAP_RETENTION_SWEEP_MS` | `24h` / `60s` | How long a released session stays readable (and its media answers `410`); how often retention is swept |
| `MULTITAP_AUTO_SELECT_MAX_ATTEMPTS` / `MULTITAP_AUTO_SELECT_RETRY_AFTER_MS` | `5` / `30s` | Auto-select: candidates tried before giving up; when a failed torrent is retried once ([[decision/auto-select-and-fallback]]) |
| `MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS` | `45s` | Auto-select: how long one candidate may take before core abandons it and tries the next; `0` = no limit, otherwise at least 5 s. A picked source keeps the engine's timeouts ([[decision/auto-select-and-fallback]]). |
| `MULTITAP_ENGINE_ADMISSION` / `MULTITAP_ENGINE_LOAD_WINDOW_MS` | `warn` / `60s` | A new session on an engine whose resolving and playing sessions reach its `liveConcurrency`: `off`, `warn` (log) or `reject` (`503` + `Retry-After`); a ready session counts as playing for this long after a segment request ([[architecture/engine-session-lifecycle]]) |
| `MULTITAP_ENGINE_HEALTH_INTERVAL_MS` / `_TIMEOUT_MS` / `_MAX_BACKOFF_MS` | `30s` / `5s` / `60s` | Engine health checks (`GET /metrics`): interval while answering, timeout, backoff cap while not (also the cap of the release retry backoff, [[architecture/engine-retention]]). A changed address or transport resets the engine's health to unknown until the next check; an offline engine that answers any request is re-checked at once ([[architecture/engine-transport-and-health]]). |
| `MULTITAP_ENGINE_CONNECT_TIMEOUT_MS` | `3s` | Connect timeout (TCP and TLS) of `lan` engine requests, 100 ms–60 s, under the per-call timeouts: a host that drops connections fails as `engine-offline` quickly ([[architecture/engine-transport-and-health]]) |
| `MULTITAP_ENGINE_SESSION_TTL_MS` | unset (e.g. `48h`) | Per-session engine `ttl` (#25) sent to engines with `sessionOverrides`: the safety net for a session core never manages to delete ([[architecture/engine-retention]]). 60 s–30 d, at least `MULTITAP_RETENTION_IDLE_MS`; unset sends none. |
| `MULTITAP_ENGINE_TIMEOUT_{CONTROL,PREPARE,MEDIA}_MS` | `10s` / `150s` / `200s` | Engine request timeouts; media stays above server-go's segment timeout ([[architecture/media-gateway]]) |
| `MULTITAP_EVENTS_REPLAY_SIZE` / `MULTITAP_EVENTS_HEARTBEAT_MS` | `1000` / `15s` | `Last-Event-ID` replay buffer; SSE heartbeat comment interval ([[architecture/core-events-sse]]) |
| `MULTITAP_SELECTION_DEFAULT_HIGH_RES` (`selection.defaultHighRes`) | `off` | Used when a request doesn't set `highRes` ([[concept/source-ranking]]) |
| `MULTITAP_SELECTION_DEFAULT_ENGINE` | unset | Engine used when a request names none and the candidate requires none ([[decision/auto-select-and-fallback]]); unset means the only engine there is, and with none or several such a request gets `400`. The engine it names can't be deleted. The maintainer's compose file sets `home` |
| `MULTITAP_SESSION_MAX_BITRATE` | `20M` | Ceiling for a session's `quality.bitrate` ([[architecture/rendition-and-bandwidth]]): bits per second, with `k`/`M` suffixes, 100k–200M. A plain ceiling: raise it (e.g. `50M`) if the upload allows. |
| `MULTITAP_SESSION_BITRATE_BY_HEIGHT` | `240=600k,360=1M,480=1.5M,576=2M,720=3M,1080=6M,1440=10M,2160=16M` | Bitrate derived for a request with `maxHeight` and no `bitrate` ([[architecture/rendition-and-bandwidth]]): `height=bitrate` pairs, any order, bitrates not falling with height; the first rung at or above the height applies, else the top one. Capped at `MULTITAP_SESSION_MAX_BITRATE` and the engine's `defaultBitrate`. `off` derives nothing. |
| `MULTITAP_SELECTION_PREFERRED_LANGUAGE` | `eng` | Default preferred audio language for ranking ([[concept/source-ranking]]) |
| ranking | `/v1/admin/ranking` → `settings` table | Score weights and size limits ([[concept/ranking-settings]]); defaults built in |
| `MULTITAP_ADDON_TIMEOUT_{CATALOG,META,STREAMS,SUBTITLES,MANIFEST}_MS` | `5000` / `5000` / `10000` / `5000` / `10000` | Per-request addon timeouts; streams and manifests get longer ([[concept/addon-aggregation]]) |
| `MULTITAP_ADDON_CIRCUIT_FAILURES` / `MULTITAP_ADDON_CIRCUIT_RESET_MS` | `5` / `60000` | Addon circuit breaker: failures before opening, and how long it stays open |
| `MULTITAP_ADDON_MANIFEST_REFRESH_MS` / `MULTITAP_ADDON_RESPONSE_CACHE_ENTRIES` | `6h` / `1000` | Manifest refetch interval; addon response cache size |
| `MULTITAP_ADDON_USER_AGENT` | `Multitap/<version> (+https://multitap.dev)` | `User-Agent` of addon manifest and resource requests (printable ASCII, 1 to 200 characters) |
| `MULTITAP_DEFAULT_ADDONS` | empty | Comma-separated manifest URLs, installed once at start when the addon collection is empty (secret like any manifest URL; failures log the host only). Nothing is built in |
| `MULTITAP_STREAM_STORE_TTL_MS` | `6h` | How long a source list's candidate keys stay valid; older keys get `409` on session create |
| `MULTITAP_ADDON_PRIVATE_ALLOW` | empty | Comma-separated IPs, CIDRs and host names that addon redirects and subtitle files may reach although they are private (a LAN addon or subtitle host). Everything else private, loopback, link-local or metadata is refused; a metadata address only when listed exactly. An invalid entry stops startup ([[architecture/addon-private-host-guard]]) |
| `MULTITAP_SUBTITLE_TIMEOUT_MS` / `MULTITAP_SUBTITLE_MAX_BYTES` | `10000` / `5242880` (5 MiB) | Fetching an addon subtitle file |
| `MULTITAP_SEGMENTS_PROVIDERS` | empty (module off) | **Planned ([[architecture/segments-module]]).** Comma-separated segment providers to enable, e.g. `introdb`; empty leaves the module unmounted and `/v1/segments` answers `404`. |
| `MULTITAP_SEGMENTS_TIMEOUT_MS` / `MULTITAP_SEGMENTS_CACHE_TTL_MS` / `MULTITAP_SEGMENTS_NEGATIVE_TTL_MS` | planned: e.g. `4000` / `30d` / `1h` | **Planned ([[architecture/segments-module]]).** Per-provider request timeout; how long a found segment list is cached (long); how long "none found" or a failure is cached (short). Names and values are provisional; per-provider overrides (`SEGMENTS_<PROVIDER>_…`) if needed. |
| `MULTITAP_SEGMENTS_USER_AGENT` | planned: `Multitap/<version> (+https://multitap.dev)` | **Planned ([[architecture/segments-module]]).** `User-Agent` of provider requests; one rate limit and one cache apply to all callers. |

## What is a setting

Anything an operator might reasonably tune (timeouts, limits, TTLs, score weights) is configuration: environment variables for operational limits read at startup, database settings behind the admin API for preferences that change while running (ranking, engines, addons). Constants in code are for protocol facts, parser vocabulary, regexes, file layout and security policy (redaction keys, CSP). Secret variables have a `_FILE` variant.

The first API key is created with core's CLI (`docker exec multitap multitap api-key create --scope admin --label bootstrap`).

Configure server-go **only through env vars**; core never writes the engine's `transcode*` `/settings` keys (Reference engine configuration).

Related: [[concept/engine-descriptor]], [[architecture/core-deployment]].
