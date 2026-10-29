# Changelog

All notable changes to `@multitap/core` and its `/v1` API. The OpenAPI document
(`packages/api/openapi.json`) carries the same version in `info.version`.

## Versioning rules

- Releases are tagged `vX.Y.Z`. The three packages share the version, and the
  OpenAPI document's `info.version` is the release.
- **`/v1` changes are additive by default:** a new route, a new optional
  request field or parameter, a new response field. They ship in a patch
  release.
- **Checked on every change.** `pnpm run ci` runs `pnpm run api:diff`, which
  compares the generated OpenAPI document with the latest `v*` tag
  (oasdiff) and fails on any change it rates as breaking, including a new value
  in a response enum.
- **While Multitap is `0.x`, a breaking `/v1` change is allowed, but only on
  purpose:** it is accepted in `packages/api/breaking-accepted.txt` (so
  the check passes), ships in a minor release (`0.1.x` to `0.2.0`), and is
  listed here under "Breaking changes". A client that pins a minor version
  gets no breaking change.
- **From `1.0`, `/v1` takes no breaking changes.** They go to a new `/v2`
  path instead.

Releases 0.1.0 to 0.1.4 were made under an earlier name, inside another
repository; their tags are not part of this repository's history.

## 0.2.0 (2026-10-29)

The first release as Multitap, from its own repository.

### Security

- **The engine's proxy password goes only where Multitap put it.** Before, an
  addon's plain `url` stream pointing at the engine's own `/proxy/stream` got
  the stored proxy password appended, and a `proxyHeaders` source reached
  hosts the engine allows only for `/proxy` through its media routes. Now the
  password goes only on the `/proxy/stream` URL Multitap builds for a
  `proxyHeaders` source; that source's target must pass the private-host
  guard (a private host only when `MULTITAP_ADDON_PRIVATE_ALLOW` lists it);
  and an addon stream URL on loopback or on the engine's own host is refused
  as `unsupported` (okf:core-review/sec-input-engine-proxy-password).
- **A media token minted while its subject was being revoked no longer comes
  back to life.** The revocation now lasts as long as that token, also after
  a restart (okf:concept/media-tokens).
- **Addons can no longer aim Multitap at the engine or the LAN.** Redirects of
  addon requests, and every hop of a subtitle file fetch, must now reach a
  public address: loopback, private, link-local, CGNAT, metadata and
  unspecified addresses are refused (IPv4-mapped IPv6 included), checked on IP
  literals and at connect time on resolved names, so DNS rebinding can't get
  through. Before, one catalog redirect or subtitle URL could make Multitap call
  the engine's `GET /removeAll`. Installing an addon from a private manifest
  URL still works. A refused addon request fails as `network`, a refused
  subtitle file as a `502` (okf:architecture/addon-private-host-guard).
- **New setting `MULTITAP_ADDON_PRIVATE_ALLOW`** (comma-separated IPs, CIDRs and host
  names, default empty) for LAN addons that redirect within the LAN and LAN
  subtitle hosts. A metadata address is exempt only when listed exactly; an
  invalid entry stops startup (okf:architecture/configuration).
- **Hostile addon text can no longer freeze Multitap.** The regexes Multitap runs over
  stream labels, meta names and runtimes and subtitle files are linear (some
  took hours on a few megabytes), and a stream's `name`, `description`,
  `title`, `behaviorHints.filename` and `bingeGroup` are cut to 4096
  characters when the addon response is parsed (okf:concept/addon-aggregation).
- **Revoking an API key ends its open `/v1/events` streams.** Before, a
  stream opened before the revocation kept delivering every event,
  admin-only ones included, until the client went away. The stream now
  re-checks its key each time it wakes for an event or a heartbeat, before
  sending anything, so it also ends after `multitap api-key revoke` from the CLI
  (within one `MULTITAP_EVENTS_HEARTBEAT_MS` when idle). Multitap logs
  `event stream ended: api key revoked` with the key id
  (okf:architecture/core-events-sse).
- **Multitap warns when the API is exposed over plain HTTP.** At startup, if the
  `/v1` listener is on a non-loopback address (the default, every interface)
  without TLS, Multitap logs a warning: every request carries an API key in
  cleartext. The default bind is unchanged, since a container needs it; in
  Docker the warning is expected as long as 8080 isn't published. The
  Dockerfile's example now publishes the API on loopback only
  (okf:architecture/network-and-deployment-exposure).

### Added

- **SECURITY.md** (repository root): how to report a vulnerability
  privately, which versions get fixes, Multitap's threat model, and what is in
  and out of scope.
- **A licence.** Multitap and its image are AGPL-3.0-only; `@multitap/api` and
  `@multitap/addon-protocol` are MIT. The image carries
  `org.opencontainers.image.licenses` and `/app/LICENSE`. Contributions are
  signed off under the DCO (CONTRIBUTING.md).
- **An automatic backup before migrating.** When an existing database has
  pending migrations, Multitap (and the CLI, if it opens the database first)
  writes a verified online backup to `<MULTITAP_BACKUP_DIR>/pre-migration/` first,
  named after the first pending migration. The newest 3 are kept, apart from
  the `/v1/admin/backups` list and `MULTITAP_BACKUP_KEEP`. If the backup fails, the
  upgrade doesn't start (okf:architecture/core-persistence).

### Changed

- **Multitap has its own repository.** The server is `packages/core`, the
  client packages are `packages/api` and `packages/addon-protocol`, and
  releases are tagged `vX.Y.Z` (see "Versioning rules"). `@multitap/addon-protocol`
  now carries the release version too.
- **The packages work outside the workspace.** Each packs only what it
  needs (`files`: `dist/`, plus `openapi.json` for `@multitap/api` and
  `migrations/` and `dev/` for `@multitap/core`), and its packed manifest
  points `types` and `default` at `dist/` (`publishConfig.exports`), with no
  `development` condition and no `src/`. `@multitap/api` exports
  `./openapi.json`, and `@types/better-sqlite3` is a dependency of
  `@multitap/core`, whose declarations use it. `pnpm run build` builds
  `dist/` with declaration files a consumer can resolve, and
  `pnpm run pack:check` (part of `pnpm run ci`) packs the three packages,
  installs them into a project outside the workspace, imports them with plain
  `node` and typechecks a strict NodeNext consumer.
- **Core is now Multitap** (okf:decision/core-public-name-multitap). Nothing
  answers to the old names any more:
  - the packages are `@multitap/core`, `@multitap/api` (was `@yhm/core-api`)
    and `@multitap/addon-protocol` (was `@yhm/stremio`). The client exports
    `createMultitapClient`, `MultitapClient` and `MultitapEvent*` (were
    `createCoreClient`, `CoreClient` and `CoreEvent*`);
  - every environment variable but `NODE_ENV` has the `MULTITAP_` prefix
    (`MULTITAP_API_PORT`, `MULTITAP_DATA_DIR`, …);
  - every metric has the `multitap_` prefix. The gauge
    `event_subscribers_total` is now `multitap_event_subscribers`, and
    `http_request_duration_ms` is now `multitap_http_request_duration_seconds`,
    counted in seconds;
  - the image is `ghcr.io/multitap-media/multitap` (not published yet), and
    its CLI is `multitap`;
  - the addon `User-Agent` is `Multitap/<version> (+https://multitap.dev)`,
    and the OpenAPI document's title is `Multitap API`;
  - the database file is `multitap.sqlite`, the log files are
    `multitap.<date>.<n>.log`, and backup ids are
    `multitap-<UTC timestamp>`. The `/v1/admin/backups` id pattern changed
    with them.
- **Multitap seeds no engine.** A fresh database no longer gets an engine `home`
  with one particular machine's capabilities (QuickSync, 1080p live, tone
  mapping). Until an admin adds one with `PUT /v1/admin/engines/{id}`, source
  lists and sessions answer `400` saying so, and Multitap logs a warning at
  startup. A database that already has engines keeps them.
- **`MULTITAP_SELECTION_DEFAULT_ENGINE` has no default.** Unset, a request that names
  no engine uses the only engine there is; with several it must name one
  (`400` otherwise). Set it to keep the old behaviour, e.g.
  `MULTITAP_SELECTION_DEFAULT_ENGINE=home`; the engine it names still can't be
  deleted.
- The OpenAPI document's descriptions and examples are written for any
  client (no internal design references, phase numbers or watch-party
  examples). No schema change.
- `/v1` compatibility is now checked by `pnpm run ci` (see "Versioning rules").

### Fixed

- **Migrations are atomic.** The pending migrations and their bookkeeping rows
  now run in one `BEGIN IMMEDIATE` transaction, so a full disk, crash or kill
  part-way leaves the database as it was and the next start completes the
  upgrade. Before, a half-applied migration failed with "table already exists"
  on every later start. Multitap and the CLI migrating the same file now take
  turns instead of racing (okf:architecture/core-persistence).
- **Table rebuilds in a migration no longer cascade-delete child rows.**
  Foreign keys are off while migrations run and `PRAGMA foreign_key_check`
  runs after each one; a migration that leaves a broken reference fails and
  rolls back (okf:architecture/core-persistence).
- **Graceful shutdown no longer hangs while an event stream is open.** Multitap
  now ends open `GET /v1/events` streams when it shuts down, and cuts any other
  response still open after 5 s, so held-back watch progress is flushed and the
  process exits 0. Before, a connected client (most keep one open) made
  every stop hit the 10 s force-exit and lose up to 90 s of progress per
  playing profile. Clients see the stream end and reconnect with
  `Last-Event-ID` (okf:architecture/core-events-sse).

## 0.1.4 (2026-10-15)

### Changed

- **The media gateway retries an engine `502` or `504` on a segment once**,
  for any session, as it already did for a `404` on a session that has served
  segments. An engine with upstream PR #53 reports a source that failed
  mid-stream this way instead of with a `404` (okf:architecture/media-gateway).
- **A torrent create the engine refuses with `503`** (upstream's
  `STREMIO_MAX_ENGINES` cap) is retried once after the engine's
  `Retry-After` (capped at 10 s). If it's refused again the attempt fails with
  the new reason `engine-busy`; auto-select then skips the remaining torrents,
  still tries other sources, and fails the session `engine-busy` if none
  plays. `failureReason` is a string, so the new value isn't a schema change
  (okf:architecture/engine-prepare-stream).

## 0.1.3 (2026-10-09)

### Added

- **Per-item player state** (phase 3 P1, stremio-core's `StreamItemState`):
  `GET`/`PUT /v1/profiles/{id}/items/{type}/{itemId}/state` keep a profile's
  `audioLanguage`, `subtitle` (`embedded` by language and index, `addon` by
  language, addon id and optional file id, or `off`), `subtitleOffsetMs` and
  `playbackSpeed` for an item, one row per profile and item (migration
  `0011_item_player_states`, deleted with the profile). A `PUT` replaces the
  fields it gives (null clears) and keeps the rest; nothing stored reads as the
  empty state with `updatedAt: null`. Library and continue-watching items
  carry it as the optional `playerState`.
- A session created with `profileId` and no `audioLanguage` takes the item's
  stored `audioLanguage` (so `audioTrack` follows it), and starts with the
  stored `subtitleOffsetMs` on the chosen addon subtitle file
  (`GET …/subtitles` reports it as that track's `offsetMs`).

### Changed

- The profile `name` pattern spells out ECMAScript's whitespace class instead
  of `\S` (same validation; other regex engines, such as the contract run's
  generator, read `\S` differently). `api:diff` reports it as a pattern-change
  warning, not a breaking change.

## 0.1.2 (2026-10-06)

### Added

- `GET /v1/whoami`: the calling API key's `id`, `scope`, `label`, `createdAt`
  and `lastUsed` (never the key or its hash), so a client can tell which key it
  holds. Any `client` or `admin` key; a `metrics` key gets 403.

## 0.1.1 (2026-10-06)

### Added

- **Safety flags** (found in a MediaFusion test, 2026-10-06: its debrid
  watchlist lists a "delete all files" item). A new `safety` ranking settings
  group (`titlePatterns`, default `delete all`, `remove all`, `clear all`,
  `wipe`, `purge all`, `format`; `idPrefixes`, default empty) flags matching
  items and their sources `destructive`: an optional `flags` field on
  `MetaPreview`, `MetaDetail` and `SourceCandidate` (present only when
  flagged) and `explain.flags` with the matching setting. Auto-select never
  picks a flagged source and fails with the new `failureReason`
  `only-flagged` when nothing else plays; a source picked by key still plays
  and logs a warning (key and flags only). `GET /v1/streams` still lists them.
- **Uncached debrid sources rank lower.** An hourglass (`⏳`, `⌛`) in a
  stream's label now sets `parsed.cached: false`, like Torrentio's
  `[RD download]`. A new `debrid.uncachedPenalty` setting (default 2000)
  applies to them as the `uncached` explain rule, on top of the HTTP tier, so
  they rank below healthy cached and torrent sources but auto-select still
  reaches them. With the defaults, `[RD download]` sources keep their phase 2
  score (1000); their `explain` now shows `tier` 3000 and `uncached` -2000
  instead of `tier` 1000.
- `debrid` and `safety` are later ranking groups: a `PUT` preset without them
  still imports.

### Changed

- `ENGINE_HEALTH_MAX_BACKOFF_MS` defaults to 60 s (was 5 min), so an offline
  engine nobody sends requests to is checked at least once a minute. The same
  value caps the retry backoff of unconfirmed engine releases, so with the
  default 60 s sweep they are retried every minute (skipping engines seen
  offline) instead of backing off to 5 min.
- New `ENGINE_CONNECT_TIMEOUT_MS` (default 3 s, 100 ms–60 s): the connect
  timeout (TCP and TLS) of `lan` engine requests, below the per-call timeouts.
  Adds the `undici` package (8.10.2, the version Node 26 bundles) for the
  dispatcher; requests still use the global `fetch`.

### Fixed

- A returned engine was treated as offline until its next health check: in a
  engine restart test (engine stopped for ~22 s, 2026-10-05) new sessions
  failed with `engine-offline` for ~10 s after it was back while the gateway's
  segment requests to it succeeded. Now any `2xx` from an engine core has
  offline resets its backoff and triggers a health check at once (one at a
  time, at most every 5 s); the check still decides `online`.
- A stopped engine host that silently drops connections made every engine
  request wait undici's 10 s connect timeout. It now fails after
  `ENGINE_CONNECT_TIMEOUT_MS`, as a network error (`engine-offline`) as before.

- `GET /v1/meta/{type}/{id}` no longer passes on meta `links` that are Stremio
  deep links carrying an addon URL (`stremio:///discover/{transportUrl}/…`,
  e.g. AIOMetadata's genre links). The transport URL is the addon's manifest
  URL and can hold its configuration or credentials; found in the real-addon
  test (2026-10-05). Other links, such as `stremio:///search?…`, are kept.

## 0.1.0 (end of phase 2)

The first tagged release: phases 1 and 2 of the build plan. Core is a complete,
standalone, headless Stremio client with a remote engine.

### Breaking changes

- Relative to the phase 1 baseline: `metrics` was added to the `ApiKey.scope`
  response enum (`GET`/`POST /v1/admin/api-keys`, `DELETE
  /v1/admin/api-keys/{id}`). It affects admin clients only; accepted
  2026-10-01.
- Relative to the phase 1 baseline: the addon `status` response field gained
  the value `needs-configuration` (addons whose manifest asks to be configured),
  on the catalog, meta, streams and subtitles responses. A client that switches
  exhaustively on the status must handle it.

### Addon layer (phase 1)

- Addon collection through the admin API: add by manifest URL (secret, never
  returned or logged), reorder, enable and disable, refresh, patch, delete, and
  `POST /v1/admin/addons/preview` to fetch and validate a manifest without
  storing it. `DEFAULT_ADDONS` installs a first set at startup; `ADDON_USER_AGENT`
  sets the `User-Agent` of addon requests (default: the earlier product name and the version).
- Catalogs and catalog pages with the extras each catalog declares, meta,
  one search across every search-capable catalog (`GET /v1/search`), and
  subtitles converted to WebVTT, with the file hints (`videoHash`, `videoSize`,
  `filename`) passed to addons as extras.
- Aggregation with timeouts, a circuit breaker and a response cache.
- Source lists (`GET /v1/streams/{type}/{videoId}`): release-name parsing,
  playability per engine, addon order or `sort=rank`, incremental delivery
  (`streams.partial` events), and `explain=true` for each candidate's score
  breakdown.
- Ranking as settings (`/v1/admin/ranking`: `GET`, `PATCH`, `PUT`, `DELETE`):
  weights and per-resolution size limits, meta-aware episode and title
  mismatch scoring, a runtime-aware size check, a per-request preferred
  language, and a `bingeGroup` bonus.
- Scoped API keys (`client`, `admin`, `metrics`) and the `core` CLI
  (`api-key create|list|revoke`, `engine proxy-password`).

### Engines and sessions (phase 2)

- Engine descriptors (`/v1/admin/engines`) with health checks and backoff
  (`online`, `lastSeen`), a typed stremio-server-go client and the engine
  module: torrents, URLs, `proxyHeaders` through `/proxy/stream`, VOD HLS and
  YouTube; warm start; per-session quality on engines with `sessionOverrides`.
- The engine's proxy password as a write-only secret; a retrying release
  (`DELETE` on the engine is retried until it is confirmed) and the optional
  `ENGINE_SESSION_TTL_MS` safety net.
- Admission control (`ENGINE_ADMISSION`), a derived bitrate from `maxHeight`
  (`SESSION_BITRATE_BY_HEIGHT`) and an auto-select attempt timeout.
- Playback sessions (`/v1/sessions`): a picked source or auto-select with
  fallback, idempotency by key, retention, release (`released` answers `410`),
  an audio and subtitle track list with `audioTrack`, auto-next through
  `preferBingeGroup`, and streams embedded in an addon's meta. `mode: 'full'`,
  `readyBy`, and `delivery: 'direct' | 'remux'` answer `501`.
- Media tokens and the gateway on the separate media listener: one HLS URL per
  viewer, revocable per subject or all at once, viewer telemetry, and addon
  subtitles under the same token, with a server-side timing offset (`offsetMs`)
  per request and per session.
- `GET /v1/events` (server-sent events) with schemas, `Last-Event-ID` replay
  and heartbeats.

### Profiles and library

- Profiles (create, list, get, rename, delete) with sparse settings, and
  Stremio-format libraries: add, remove, rewind, mark an item, an episode or a
  season watched, progress with stremio-core's rules, continue watching, next
  episode, and the last source played per item.

### Operations

- Environment configuration, validated at startup (
  okf:architecture/configuration), including `API_BIND` and `MEDIA_BIND`.
- CORS from `CORS_ORIGINS`, optional built-in TLS with `SIGHUP` reloads, and
  absolute media URLs from `MEDIA_PUBLIC_BASE`, so core needs no reverse proxy.
- Database backups through `/v1/admin/backups` (online SQLite backup, optional
  schedule, retention).
- Rotating JSON log files (`LOG_DIR`), with redaction at `info` and above.
- Prometheus metrics on `/metrics` behind the `metrics` scope
  (`@prometheus-io/client`).
- A generated OpenAPI 3.1 document and typed client (`@yhm/core-api`), checked
  with Schemathesis (stateful, through OpenAPI links) and oasdiff.
- A development-only `/dev` page with an hls.js player.
