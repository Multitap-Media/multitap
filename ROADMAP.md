# Multitap roadmap

Everything outstanding for **Multitap** as a product: a menu of goals for filling
out the service, not a schedule. Last updated 2026-10-29, at Multitap **0.2.0**.

## What Multitap is

Multitap is a standalone, headless Stremio client with a remote engine. It browses
Stremio addons, lists and ranks sources, runs playback sessions on a streaming
engine (developed and tested with
[stremio-server-go](https://github.com/M0Rf30/stremio-server-go)) and serves
their media to any number of players through revocable media tokens,
and keeps Stremio-format profiles and libraries, all behind a schema-first
HTTP API (`/v1`, OpenAPI 3.1, with a generated typed client). It has no UI and
no human sign-in: clients use API keys, players use media tokens. See
[README.md](README.md) for what works today and [CHANGELOG.md](CHANGELOG.md)
for releases.

Its design is the OKF bundle in [`knowledge/`](knowledge/project-map.md)
(linked below as `okf:` concept ids). Apps with rooms, accounts or devices are
clients of Multitap, built on its `/v1` API; they are not part of it.

Terms used below: the **engine** is the transcoding streaming server Multitap
drives over the LAN, here stremio-server-go, the one Multitap is developed and
tested with; the **reference deployment** is
the setup Multitap was tested on: an Intel mini-PC with QuickSync running the
engine on Windows, and Multitap run from source on another host behind a
reverse proxy.

## How to read it

- **Status:** `[ ]` planned, `[~]` partial (some of it is built), `[x]` done
  recently (kept for context; see the last section).
- **Size:** **S** (hours to a day), **M** (days), **L** (a week or more, often
  several PRs). Rough, and blank where unknown.
- **Area:** `multitap` (this service), `engine` (an upstream change to
  stremio-server-go, tracked in
  [M0Rf30/stremio-server-go#43](https://github.com/M0Rf30/stremio-server-go/issues/43);
  Multitap detects each engine feature at runtime and keeps working without it),
  `app` (belongs to an app or people layer built on Multitap, never in Multitap).
- **Source:** where the item is recorded. An `okf:` reference is a concept id in the
  `knowledge/` bundle; `#43` is the engine tracking issue; `adversarial review`
  is the October 2026 adversarial review of Multitap (okf:core-review/summary,
  one concept per finding in the bundle's `core-review/` folder). `gap` (a
  comparison with stremio-core and the addon SDK), `phase 2`, `ladder` (the
  engine ABR ladder scoping) and `owner notes` (findings from the 2026-10-06
  test sessions) name write-ups from before Multitap had its own repository;
  they aren't published, and each item says what it needs on its own.
- **Buckets:** [Before publishing](#before-publishing-cleanup-and-review),
  [Next](#next), [Later](#later), [Ideas / maybe](#ideas--maybe) and
  [Deliberately out of scope](#deliberately-out-of-scope). Within a bucket,
  items are ordered by value and urgency, most important first.

## Before publishing (cleanup and review)

Multitap is to be published as its own project after a cleanup and a thorough
review. This is that checklist.

### Review passes

- [ ] **API consistency review of every `/v1` route** · M · `multitap` — path
  shapes, verbs, status codes, request and response field names, idempotency,
  and how optional features are declared (`501` for `mode: 'full'`, `readyBy`,
  `delivery: 'direct' | 'remux'`). Fix what's inconsistent while breaking
  changes are cheap (0.x; each one goes in the changelog). _Source: owner
  notes._
- [ ] **Error model review** · S · `multitap` — RFC 9457 problem bodies
  everywhere: one documented list of problem types and `errorCode`s, consistent
  use of `404` (also returned for a bad API key), `403`, `409`, `410`, `422`,
  `501` and `503` with `Retry-After`. _Source: owner notes; okf:architecture/core-v1-api._
- [ ] **Pagination conventions** · M · `multitap` — one convention for list
  routes. Today catalogs use the addon protocol's `skip`, and the library,
  continue watching, search, backups and API-key lists return everything.
  Decide limit/cursor (or document "unpaged, small"), before clients depend
  on it. _Source: owner notes; gap (library paging)._
- [x] **Naming review** · S · `multitap` — done 2026-10-25: the name is
  **Multitap** (okf:decision/core-public-name-multitap), applied to the
  packages (`@multitap/core`, `@multitap/api`, `@multitap/addon-protocol`),
  the image (`ghcr.io/multitap-media/multitap`), the `multitap` CLI, the
  `MULTITAP_` environment variables, the `multitap_` metrics, the addon
  `User-Agent` (`Multitap/<version> (+https://multitap.dev)`), the OpenAPI
  title, the data, log and backup file names, and the wording. No old names
  are kept. Since 0.2.0 the directories match: `packages/core`,
  `packages/api`, `packages/addon-protocol`. _Source: owner notes._
- [x] **Metric naming fix** · S · `multitap` — done 2026-10-25 with the
  naming review: the gauge `event_subscribers_total` is
  `multitap_event_subscribers`, and the request histogram is
  `multitap_http_request_duration_seconds` (base units). _Source: phase 2
  (Deviations)._
- [ ] **OpenAPI quality pass** · M · `multitap` — a description, `operationId`,
  tag and example on every route and schema, the security schemes and error
  responses complete, lifecycle `links` on every lifecycle route, and an
  OpenAPI linter in CI. The document is generated from zod schemas
  (okf:architecture/core-api-testing), so this is work in `src/http/routes/` and
  `packages/api`. _Source: owner notes._
- [x] **Security review** · M · `multitap` — done 2026-10-20 as part of the Multitap
  adversarial review (okf:core-review/summary): SSRF in addon, manifest and
  subtitle fetches and in what Multitap hands the engine, media tokens and
  revocation, API key storage and scopes, CORS and TLS defaults, the media
  listener's filename allowlist, hostile addon input. Its 8 release blockers
  are fixed, and on 2026-10-25 so are two of its "fix soon after" findings
  (an open event stream outliving its key's revocation, no warning for a
  public plain-HTTP API listener). The rest are under
  [Next](#adversarial-review-findings-2026-10). _Source: owner notes;
  okf:architecture/security-trust-domains; adversarial review._
- [x] **Log redaction audit** · S · `multitap` — done 2026-10-20 by the same
  review (okf:core-review/sec-access-progress, "Logs" and "Responses"): no
  secrets in log lines at `info` and above (key-name redaction, engine error
  text filtered and stripped of the proxy password) or in any `/v1` response,
  event, problem detail or metrics label. Debug and trace levels redact nothing by design
  (okf:architecture/secrets-policy). _Source: owner notes;
  okf:architecture/secrets-policy; adversarial review._
- [ ] **Dependency and licence audit** · S · `multitap` — `pnpm audit`, pinned
  versions (Renovate is configured), the licences of every runtime dependency,
  and Multitap's own licence, chosen 2026-10-20: AGPL-3.0-only for Multitap and its
  image, MIT for `@multitap/api` and `@multitap/addon-protocol` (see the README's
  Licence section and CONTRIBUTING.md). Third-party addons reviewed for the docs (e.g. GPL-3.0
  AIOMetadata) are used as services, never copied. _Source: owner notes; gap
  §4._
- [x] **App-specific wording out of Multitap's docs and code** · M ·
  `multitap` — done 2026-10-26 with the repository split. The OpenAPI document
  has no `okf:` or phase references and no app examples (2026-10-20), Multitap
  seeds no `home` engine, the product name is applied (2026-10-25), and the
  design concepts the code cites (`okf:` comments) are this repository's own
  bundle, rewritten for Multitap. Phase numbers in code comments refer to the
  build history in okf:process/build-plan. _Source: owner notes; adversarial
  review._

### Repository and release hygiene

- [x] **Secrets scan of the git history** · S · `multitap` — done
  2026-10-26: fixtures are redacted by rule
  (`packages/addon-protocol/test/fixtures/real/README.md`), and a betterleaks
  scan of this repository's history and working tree came back clean, as did
  a sweep for private hostnames and LAN addresses. `pnpm run ci` scans again
  on every run. _Source: owner notes;
  okf:decision/core-public-repo-fresh-history._
- [x] **Repository split** · L · `multitap` — done 2026-10-26: Multitap has its
  own repository with fresh git history (no history carried over), the
  server in `packages/core`, the client packages in `packages/api` and
  `packages/addon-protocol`, with the workspace, the lint boundary rules,
  the test fakes, the contract harness and `scripts/linux-run.sh`. The first
  commit is tagged `v0.2.0`, the `api:diff` baseline. _Source:
  okf:architecture/overview; okf:decision/core-public-repo-fresh-history._
- [x] **CI on GitHub** · M · `multitap` — done 2026-10-29, green on GitHub:
  `.github/workflows/ci.yml` runs `pnpm run ci` on Linux and
  Windows (with oasdiff and betterleaks on Linux, so `api:diff` and the
  secrets scan run there) and the Schemathesis contract run on Linux; tags are
  fetched, so `api:diff` has its `v*` baseline. _Source: owner notes;
  okf:architecture/core-api-testing._
- [ ] **README for outside users** · S · `multitap` — mostly done 2026-10-20: one
  deployment's own engines left the README, a generic engine setup (the engine
  settings Multitap relies on and what each capability means), no seeded engine,
  repository pointers kept to "Developing Multitap". Still open: the security model
  in a paragraph. _Source: owner notes; adversarial review._
- [~] **CONTRIBUTING, SECURITY (how to report), issue and PR templates** · S ·
  `multitap` — CONTRIBUTING.md exists (licences and DCO sign-off, 2026-10-20), and
  SECURITY.md (2026-10-25: private reporting, supported versions, the threat
  model and what is in and out of scope). The contact address is project@multitap.dev (2026-10-25).
  Still open: the templates, and a CI check that pull-request commits are signed off. _Source: owner notes._
- [x] **Versioning policy, written for users** · S · `multitap` — done
  2026-10-20: [CHANGELOG.md](CHANGELOG.md) "Versioning rules" and the README's
  Versioning section (additive by default; a breaking `/v1` change only in a
  minor `0.x` release, accepted in `packages/api/breaking-accepted.txt`;
  none from 1.0), enforced by `api:diff` in `pnpm run ci`. Still open: the
  Multitap version readable without a key (`/healthz` returns only `status`),
  so clients can feature-detect. _Source: CHANGELOG; okf:process/build-plan;
  adversarial review._
- [ ] **Release process and changelog automation** · S · `multitap` — version
  bump, `api:generate`, changelog, tag, image and package publishing in one
  scripted step. _Source: owner notes._

### Verification gaps to close

- [ ] **Run the Docker image on a real Docker host** · S · `multitap` — the image
  builds, but the reference deployment ran Multitap from source; the docker-host
  check was skipped (2026-10-05). The image's health
  check needs an override when Multitap terminates TLS itself. _Source: phase 2;
  README (Docker)._
- [ ] **Test the standalone TLS routes** · S · `multitap` — Multitap's own TLS
  (TLS passthrough to Multitap's certificate) and plain HTTP through a proxy were
  never exercised end to end (`self.` and `http.` hostnames in the reference
  deployment). _Source: phase 2 (Real-engine checks)._
- [x] **`pnpm run api:diff` crashes on exit on Windows** · S · `multitap` — no
  longer reproduces on Node 26.10 (13 runs from PowerShell, Git Bash and a
  shelled `spawnSync`, 2026-10-20); `api:diff` now runs in `pnpm run ci`,
  so a recurrence shows there. _Source: owner notes._
- [ ] **Flaky test history** · S–M · `multitap` — the ECONNRESET family under
  full-suite load: the gateway test helper retries a `GET`/`HEAD` once on
  ECONNRESET (a pooled keep-alive socket the server just closed); the CORS/TLS
  tests were hardened. Find the root cause rather than keep the retry. The
  ReDoS timing case for `parseStream` passed 100 ms under load twice on
  2026-10-26 (25 ms alone); it has a 500 ms limit now. _Source: owner notes;
  `test/gateway.test.ts`, `test/addon-text-redos.test.ts`._

### Docs and packaging for outside users

- [ ] **API reference rendered from the OpenAPI document** · S · `multitap` —
  _Source: owner notes._
- [ ] **Deployment guides** · M · `multitap` — bare host, Docker, behind a reverse
  proxy, with Multitap's own TLS; setting up the engine next to it (version,
  settings Multitap relies on, keeping it unreachable: the engine has no
  authentication). _Source: owner notes; README; okf:architecture/network-and-deployment-exposure._
- [ ] **Examples** · S · `multitap` — curl walkthrough (exists in the README), the
  typed client, a minimal hls.js page. _Source: owner notes._
- [ ] **Publish the typed client to npm** · S · `multitap` — `@multitap/api`
  with its OpenAPI document, and `@multitap/addon-protocol`, under the
  `@multitap` npm org. They pack for outside consumers since 0.2.0, checked by
  `pnpm run pack:check`; left: drop `private` and add a publish step. _Source: owner notes._
- [~] **Publish the Docker image** · S · `multitap` — to
  `ghcr.io/multitap-media/multitap` (GitHub Container Registry, chosen
  2026-10-25). `.github/workflows/release.yml` builds it for amd64 and arm64
  on every `v*` tag and pushes `X.Y.Z`, `X.Y` and `latest`; it hasn't run
  yet. _Source: owner notes; okf:decision/core-public-name-multitap._

## Next

### Adversarial review findings (2026-10)

The findings the Multitap adversarial review (okf:core-review/summary) ranked
"fix soon after" publishing: not release blockers, but known weaknesses and
bugs a public user will meet. Each is one finding concept with its evidence
(most have a PoC test in `test/review-poc/`) and a fix direction. Low and
info findings stay in each area's progress concept.

**Security weaknesses**

- [ ] **Addon data is cached by count, not bytes** · S–M · `multitap` — the addon
  response cache (1000 entries of up to 8 MiB each) and the events replay
  buffer are bounded by count, so a hostile addon can grow the heap to
  gigabytes. Weigh entries by size with a total cap, lower the per-resource
  size caps, and cut long strings at parse time beyond the stream text
  already capped. _Source: okf:core-review/sec-input-unbounded-memory._
- [x] **The proxy plan merges the engine's two private allowlists** · S ·
  `multitap` — fixed in 0.2.0: the password goes only on the `/proxy/stream`
  URL Multitap builds for a `proxyHeaders` source, whose target must pass the
  private-host guard (`MULTITAP_ADDON_PRIVATE_ALLOW`), and addon URLs on
  loopback or the engine's host are refused. _Source:
  okf:core-review/sec-input-engine-proxy-password._
- [ ] **Segment requests run engine transcodes with no bound** · M · `multitap` —
  the gateway reads every segment to its end, for `HEAD` and for viewers
  already gone too, so one media token can queue a transcode of a whole
  title. Answer `HEAD` without a transcode and cap detached reads. Fix before
  media tokens go to people the operator doesn't trust. _Source:
  okf:core-review/bugs-playback-detached-segment-amplification._

**Bugs users will see**

- [ ] **One player per profile** · M · `multitap` — two devices of one profile
  playing different videos unload each other on every report, corrupting
  watched state and inflating watch counts. Key the player model by profile
  and device or session. _Source:
  okf:core-review/bugs-library-one-player-per-profile._
- [ ] **A playback never stopped is never unloaded** · S · `multitap` — a client
  that just goes away leaves the item on the finished episode at 95 %, and
  continue watching returns that episode. Unload idle playbacks. _Source:
  okf:core-review/bugs-library-no-idle-unload._
- [ ] **Marking the playing episode watched is undone** · S · `multitap` — the
  next progress report resets it; defer the advance to unload as
  stremio-core does. _Source:
  okf:core-review/bugs-library-mark-playing-watched-undone._
- [ ] **Incremental source lists drop early partials** · S · `multitap` — an addon
  that answers before the meta lookup finishes never gets its
  `streams.partial`, and with a synthetic part no partial carries
  `remaining: 0`. _Source: okf:core-review/bugs-library-incremental-partials._
- [ ] **Torrent keys ignore the file choice** · S · `multitap` — without
  `fileIdx`, two episodes of one pack share a key; add `fileMustInclude` and
  the filename to the key. _Source:
  okf:core-review/bugs-library-torrent-key-file-choice._
- [ ] **Session identity ignores the engine and `highRes`** · S · `multitap` — a
  keyed create asking for another engine or policy returns the old session.
  _Source: okf:core-review/bugs-playback-identity-ignores-engine-highres._
- [ ] **Orphaned engine sessions** · S–M · `multitap` — an engine session whose
  playback session never recorded it is never deleted; reconcile on start and
  in the sweep. _Source: okf:core-review/bugs-playback-orphaned-engine-sessions._
- [ ] **`Last-Event-ID` replay after a restart** · S · `multitap` — ids restart at
  1, so a reconnect after a restart can say `complete` and skip events; prefix
  ids with a per-start boot id. _Source:
  okf:core-review/bugs-playback-sse-replay-after-restart._
- [ ] **Ranking: "DV 5.1" read as Dolby Vision profile 5** · S · `multitap` — a
  normal HDR release is marked unplayable. _Source:
  okf:core-review/bugs-library-dv-channel-layout._
- [ ] **Ranking: subtitle tags read as audio languages** · S · `multitap` —
  `ENG-SUB`, `VOSTFR` and the like earn the audio-language bonus or penalty.
  _Source: okf:core-review/bugs-library-subtitle-tags-as-audio._

**Parity gaps a client builder hits**

- [ ] **Cinemeta's `metasDetailed` catalogs always fail** · S–M · `multitap` —
  the new-episode and calendar catalogs are listed but every page fails;
  accept `metasDetailed` and list-valued id extras, or hide them. Blocks the
  notifications item below. _Source:
  okf:core-review/parity-metas-detailed-catalogs._
- [ ] **A stream's own subtitles are dropped** · M · `multitap` — parsed, but
  never offered; serve them with the session's subtitles. _Source:
  okf:core-review/parity-stream-subtitles-dropped._
- [ ] **Per-episode watched is readable only through the bitfield** · S–M ·
  `multitap` — a route for one library item with its watched videos decoded, or
  `watched` on each video of a meta for a profile. _Source:
  okf:core-review/parity-per-video-watched._
- [ ] **`externalUrl` streams can't be opened** · S · `multitap` — listed as
  unplayable with the link withheld, since raw streams stay in Multitap. Expose
  the link (off by default behind a setting if secrets in it are a worry), or
  drop such candidates. Was under Ideas as "Opt-in exposure of `externalUrl`
  sources". _Source: okf:core-review/parity-external-url-hidden; gap
  (Streams)._
- [ ] **Live sources rank playable but fail** · S · `multitap` — mark live
  candidates unplayable (`live`) until Live HLS (Later) lands. _Source:
  okf:core-review/parity-live-sources._
- [ ] **New-episode notifications and a calendar per profile** · M · `multitap` —
  Multitap computes them (stremio-core's `lastVideosIds` / `calendarVideosIds`
  rule) behind `GET /v1/profiles/{id}/notifications` and `…/calendar`;
  delivering them to people is the client's. Also the per-item
  notifications toggle (`noNotif`, stored, no route). After the
  `metasDetailed` fix above. Moved here from Later. _Source:
  okf:core-review/parity-notifications-calendar; gap §2.4._

### Fixes and findings from real addons and engines

- [ ] **A bad probe cached by the engine** · M · `multitap`, `engine` — with one
  debrid HTTP source the engine recorded 720p, 120 s and one audio track for a
  1080p, 634 s file with two; the playlist ended at 2:00, the height cap and a
  track were lost, and retries reuse the cached probe. Cause unconfirmed.
  Gather evidence (probe twice, compare, inspect the cached entry), then: Multitap
  rejects or re-probes when the probe's duration disagrees badly with the
  meta's runtime; and/or an engine option to bypass or expire the probe cache.
  _Source: phase 2 (Real-addon findings); okf:process/risk-register R33, okf:process/upstream-engine-asks._
- [ ] **Anime ids that no stream addon accepts** · M · `multitap` — a meta addon
  using `kitsu:` episode ids gets an empty source list from stream addons that
  accept only `tt`, `tmdb:`, `tvdb:` and similar, with no hint why. Options:
  retry with the IMDb id from the meta's links plus season and episode, an
  id-mapping step, and an additive hint on the empty list (e.g. the unmatched
  prefix). _Source: phase 2; okf:process/risk-register R34; gap §4._
- [ ] **`mal:` and `kitsu:` ids for one show become two library items** · S–M
  · `multitap` — same root as above (no id mapping). _Source: okf:process/risk-register R34._
- [ ] **First source list after a circuit-breaker reset reports
  `circuit-open`** · S · `multitap` — _Source: owner notes._
- [ ] **Addon breaker state and `newEpisodeNotifications` missing from the
  admin addon view** · S · `multitap` — _Source: owner notes._
- [ ] **A meta answer waits for every matching addon** · S–M · `multitap` — Multitap,
  like stremio-core (`meta_details.rs`, `AggrRequest::AllOfResource`), asks
  every addon that serves meta for the type and id and shows the first good
  answer in collection order, so the answer already matches. The difference is
  latency: Multitap answers only once all of them have answered or timed out,
  where stremio-core shows the first one as soon as it's ready. Answer as soon
  as the first good meta in collection order is known. _Source: owner notes;
  adversarial review (parity, 2026-10-20)._
- [ ] **Confirm where MediaFusion puts its uncached marker** · S · `multitap` — the
  hourglass (`⏳`) that marks an uncached debrid link is matched in a stream's
  label; whether it appears in the name or the description wasn't confirmed.
  _Source: owner notes; CHANGELOG 0.1.1._
- [ ] **Real-addon coverage not yet tried** · M · `multitap` — an addon with
  `configurationRequired` (the `needs-configuration` path), audio track
  switching on a multi-audio source, `proxyHeaders` sources with the engine's
  proxy password through a real addon, incremental source lists against slow
  real addons. _Source: owner notes; phase 2._

### API completeness

- [ ] **`resumeAt` on session create** · S–M · `multitap` — start a session at a
  stored position (continuity across devices, continue watching). _Source:
  okf:architecture/playback-session._
- [ ] **A sessions list route** · S · `multitap` — `GET /v1/sessions` with
  filters (key, status, engine, profile); today a client must remember session
  ids or follow events. _Source: owner notes._
- [x] **Multitap API key self-identification** · S · `multitap` — "which key made this
  request", so an admin client can't revoke its own key by mistake. Adopted
  on 2026-10-06 as a 0.1.x addition: `GET /v1/whoami` shipped in 0.1.2.
  _Source: gap._
- [ ] **Subtitle ordering and default selection by profile language** · S ·
  `multitap` — order subtitle tracks by the profile's `subtitlesLanguage` and
  `secondarySubtitlesLanguage` (stored, unused today) and suggest a default
  subtitle track like `audioTrack` does for audio. _Source: gap (Subtitles)._
- [x] **Per-item player state** · M · `multitap` — built for 0.1.3 (decided
  2026-10-09, phase 3 P1): `GET`/`PUT
  /v1/profiles/{id}/items/{type}/{itemId}/state` keep a per-profile, per-item
  bag (audio language, subtitle choice by language and addon file id, subtitle
  offset, speed; stremio-core's `StreamItemState`), shown on library items as
  `playerState`. A session created with `profileId` takes the stored audio
  language and starts with the stored offset on the chosen addon file. Not
  done: matching the offset to the next episode's file by language (clients
  set it on the track they pick). _Source: okf:architecture/core-subtitles-and-player-state; gap §2.3._
- [~] **Library query parameters** · S · `multitap` — `type` and `removed` are
  built; `sort` (last watched, name, times watched, watched/not watched) and
  paging are not. _Source: gap (Library)._
- [ ] **Library change events** · S · `multitap` — an event when a profile's
  library changes, so two clients on one profile don't poll. _Source: gap
  (Library)._
- [ ] **Range support on media** · S–M · `multitap` — `Range` is ignored on media
  today (playlists, segments and subtitles are sent whole); direct play needs
  byte ranges on its stream path. _Source: phase 2 (Deviations); okf:architecture/media-gateway._

### Metrics

- [ ] **Gateway request duration histogram** · S · `multitap` — requests are
  counted by status only. _Source: phase 2 (Deviations)._
- [ ] **Addon outcomes for streams and subtitles** · S · `multitap` — recorded
  for catalog and meta requests only. _Source: phase 2 (Deviations)._

### Engine admission and credentials

- [~] **Engine admission control** · S–M · `multitap` — built
  (`MULTITAP_ENGINE_ADMISSION=off|warn|reject`, `503` with `Retry-After` on reject), but
  the default only warns and each engine's `liveConcurrency` is a static
  descriptor value. Make the limit come from the engine (slots in use) once it
  reports them, and revisit the default. _Source: okf:architecture/engine-session-lifecycle; README
  (Configuration)._
- [ ] **Proxy-password rotation limits** · S · `multitap` — a running engine
  session keeps the engine proxy password it started with until it is
  recreated; between changing the engine's value and Multitap's, sources fail
  their probe. Document a rotation procedure or recreate affected sessions.
  _Source: okf:architecture/secrets-policy._

### Engine: small fixes (upstream, accepted in #43)

- [ ] **Short-segment check** · S · `engine` — a segment whose video ends early
  is still cached. _Source: #43 item 1; okf:process/engine-upstream-prs._
- [ ] **A distinguishable status when the source fails mid-transcode** · S ·
  `engine` — `502`/`504` with a reason instead of `404`; Multitap retries an engine
  `404` on a segment once meanwhile. _Source: #43 item 2; okf:process/upstream-engine-asks._
- [ ] **Allowlist of private hosts/CIDRs** · S · `engine` — read media from a
  NAS or LAN host; empty by default, checked at dial time. _Source: #43 item
  3; okf:process/engine-upstream-prs._
- [ ] **`BANDWIDTH` as the peak in the master playlist** · S · `engine` — it's
  half the effective maxrate today. _Source: #43 item 4; okf:process/upstream-engine-asks._
- [x] **`api_password` in the engine's access-log redaction list** · S ·
  `engine` — fixed upstream (`a038e80`). _Source: #43 item 5._

### Engine: medium (upstream, welcome in #43)

- [ ] **Engine-side preparation** (`POST /hlsv2/{id}/prepare`) · M–L ·
  `engine` — a background job transcodes a whole session at low priority,
  reports per-segment cache status and survives restarts. Prerequisite for
  Multitap's prepare jobs (below). _Source: #43 item 6; okf:architecture/engine-prepare-ahead, okf:process/build-plan._
- [ ] **Header/index cache for HTTP sources** · M · `engine` — one data request
  per segment instead of about six; makes live debrid playback real time.
  _Source: #43 item 7; okf:process/engine-upstream-prs, R10._

### Optional module

- [ ] **Segments: skip intro/outro data** · M–L · `multitap` — an optional,
  off-by-default module (`MULTITAP_SEGMENTS_PROVIDERS`) behind
  `GET /v1/segments/{type}/{id}`, with a provider interface: IntroDB first
  (check its terms and episode addressing), then AniSkip and the source's
  chapters. Off the playback path; a failing provider never delays a session.
  The skip button itself is the client's. _Source: okf:architecture/segments-module, okf:process/build-plan,
  R31; gap §4._

## Later

### Delivery

- [ ] **Direct play** · L · `multitap` — `player` capabilities on session create,
  Multitap choosing the cheapest delivery from the engine's probe, the gateway's
  byte-range `/media/{token}/stream` path; `delivery: 'direct'` answers `501`
  today. High value for single viewers (no transcode at all). _Source:
  okf:concept/delivery-modes, okf:process/build-plan._
- [ ] **Remux** · L · `engine` (fork), then M · `multitap` — copy the video,
  convert audio and container; needs its own keyframe-aligned output. The
  engine's maintainer asked to keep it on the fork. _Source: #43 item 12;
  okf:concept/delivery-modes, okf:process/upstream-engine-asks._
- [ ] **ABR ladder in the engine** · L · `engine` — one decode, many encodes,
  rungs per request, lazy/hybrid/all production policies, a `ladder`
  capability; accepted upstream as a new session shape behind a setting,
  design issue first, after hardware decode. 3–4 PRs. _Source: #43 item 11;
  ladder; okf:process/engine-upstream-prs, okf:architecture/rendition-and-bandwidth._
- [ ] **ABR ladder in Multitap** · L · `multitap` — `quality.ladder` (+ `policy`) on
  session create, the ladder in the session identity, per-rung caps, gateway
  allowlist and telemetry for rung files, self-heal re-sending the rungs,
  admission counting rungs, the fake engine's ladder; seven checklist items.
  Built against the fake engine first. _Source: okf:process/abr-ladder-core-checklist;
  ladder §6._
- [ ] **Live HLS** · M · `multitap` — live sources through the engine's HLS proxy
  under the same media token scheme, no transcode; live is unplayable today.
  _Source: okf:architecture/media-gateway._

### Preparation

- [ ] **Prepare jobs: `mode: 'full'`, `readyBy`, `prepare.*` events** · L ·
  `multitap` — prepare a source ahead of time (e.g. a 4K film overnight) on top of
  engine-side preparation, with verification and re-queueing of lost
  preparations; both answer `501` today. _Source: okf:architecture/engine-prepare-ahead,
  okf:process/build-plan (phase 4)._
- [ ] **Transcode-ahead window** · M · `engine` — keep the next N segments
  transcoding within free slots; fewer stalls after seeks. Shares
  preparation's scheduler. _Source: #43 item 8; okf:process/engine-upstream-prs._

### Engine performance and formats

- [ ] **Hardware decode** · L · `engine` — off by default, per codec, software
  fallback; live 4K on a small iGPU (measured ~1.7 s per 4 s 4K segment with
  D3D11VA + QSV vs 6–11 s in software); libplacebo for Dolby Vision profile 5.
  Measured on the reference deployment. _Source: #43 item 10;
  okf:process/engine-upstream-prs, R1, R2._
- [ ] **YouTube through separate video and audio formats** · M · `engine` —
  `/yt` fails when YouTube withholds progressive formats, and is capped at
  360p. _Source: #43 item 9; okf:process/engine-upstream-prs, R9._
- [ ] **An engine event stream, and Multitap consuming it** · M · `engine`, `multitap`
  — stop polling the engine for health, torrent stats and preparation status.
  The maintainer wants it after preparation and the ladder. _Source: #43 item
  13; okf:process/upstream-engine-asks._

### Engines

- [ ] **Multi-engine selection** · M–L · `multitap` — the engine registry,
  per-session engine binding and capability-based ranking exist, but sources
  aren't routed across several engines automatically (affinity, load,
  capabilities such as 4K or hardware decode). _Source: okf:architecture/future-remote-engines "Remote
  engines" (seams already in place); README (Why use it)._
- [ ] **Remote engines** · L · `multitap` — a tunnel transport (engines connect
  out to Multitap, no port forwarding), a helper app bundling the engine, ffmpeg
  and a tunnel agent, pairing codes, capability reporting, local-content
  affinity (`requiresEngine`). _Source: okf:architecture/future-remote-engines, okf:process/build-plan
  (phase 5)._
- [ ] **Local files through the engine's local addon** · S–M · `multitap` — the
  engine's local-files addon now serves series episodes and indexed files over
  HTTP (upstream #31, #32); Multitap consumes it as a content addon with
  `requiresEngine`. _Source: okf:architecture/future-remote-engines._

### Library and discovery

- [ ] **Discover/board aggregate** · S · `multitap` — first page of every catalog
  in one call. _Source: gap (Catalogs)._
- [ ] **Addon catalogs (`addon_catalog`)** · S · `multitap` — community addon
  lists for discovery. _Source: gap (Addons)._

### Secrets, operations and testing

- [ ] **Encryption at rest for stored secrets** · M · `multitap` — decided once
  for all stored secrets (manifest URLs, raw streams, engine proxy password),
  with a key from the environment; deferred until a third kind of outbound
  credential appears. _Source: okf:architecture/secrets-policy._
- [ ] **Observability kit** · S–M · `multitap` — example dashboards for the
  Prometheus metrics, alert rules (engine offline, addon breaker open, backup
  failures, admission rejections). _Source: owner notes._
- [ ] **Test hardening** · M · `multitap` — more redacted real fixtures, load
  tests (many viewers per session, many sessions per engine), chaos tests
  beyond engine restarts (addon outages, slow engines, disk full), the contract
  run in public CI. _Source: owner notes._

## Ideas / maybe

- [ ] **Generic pass-through for addon resources Multitap doesn't know** · M ·
  `multitap` — a typed pass-through for resources an addon declares, so a client
  can use them without Multitap changing. Waits for a real addon to target.
  _Source: gap §4._
- [ ] **Trailer playback through a session** · S · `multitap` — trailers are
  listed as YouTube ids but aren't playable through Multitap. _Source: gap (Meta
  details)._
- [ ] **`countryWhitelist` and `notWebReady`** · S · `multitap` — parsed and
  ignored; matter with several engine locations and with direct play.
  _Source: gap (Streams)._
- [ ] **Outbound rate limiting for addon calls** · S · `multitap` — beyond the
  cache, in-flight dedupe and the circuit breaker. _Source: gap (Addons)._
- [ ] **Multitap's own preparation loop for a stock engine** · M · `multitap` — only
  if an engine without engine-side preparation must be supported. _Source:
  okf:architecture/engine-prepare-ahead, okf:process/build-plan._
- [ ] **Single-user local client** · L · `multitap` (packaging) — engine + Multitap + a
  one-person UI on one machine, direct play by default. _Source: okf:process/build-plan._
- [ ] **Per-profile addon collections** · M–L · `multitap` — each profile with its
  own addons (e.g. its own debrid account); additive, deferred: aggregation
  caches, the stream store and secrets would become per profile. _Source:
  okf:architecture/library-and-profiles; phase 2 (Tagging decision); gap._
- [ ] **House content** (pre-roll, lobby, intermission clips) · — · `app` —
  needs nothing new in Multitap: served as an ordinary content addon or from the
  engine's local addon, each piece its own session. _Source:
  okf:architecture/ideas-that-touch-core._
- [ ] **Plex content and history** · — · `app`, `engine` — content already
  comes through a Stremio Plex addon; its LAN URLs need the engine's
  private-host allowlist, and they carry Plex tokens (secrets like debrid
  links). History write-back is a client-layer feature. _Source:
  okf:architecture/ideas-that-touch-core._

## Deliberately out of scope

- **Stremio account login and sync** (library, addons, settings) — Multitap keeps
  its own state, with no vendor account; the library format keeps a later sync
  possible. _Source: gap; okf:architecture/goals-and-non-goals, okf:architecture/library-and-profiles._
- **Trakt, ratings, Stremio events/modals, account link codes, data export
  through Stremio's API** — Stremio-account services; Multitap's backups cover
  export. _Source: gap._
- **Seek logs and Stremio's premium skip-gap service** — skip data comes from
  the optional segments module instead. _Source: gap._
- **Casting and the official apps' streaming-server settings** — any player or
  cast target can play a session's media URL; the engine registry replaces the
  settings. _Source: gap._
- **Local search from Cinemeta's dataset** — tied to Cinemeta's own data;
  Multitap searches through addons. _Source: gap._
- **Live TV guide** — revisit once live HLS exists. _Source: gap._
- **Search history, spoiler hiding, content-type ordering, interface
  localisation, gamepad, Discord RPC, crash reports** — client UI concerns.
  _Source: gap._
- **Content-rating and adult filtering policy** — Multitap exposes the addons'
  `adult` hint; what to hide is the client's policy. _Source: gap._
- **Human sign-in, PIN locks, avatars** — Multitap has API keys and media tokens
  only; people and accounts belong to the client layer.
  _Source: gap; okf:architecture/goals-and-non-goals._
- **Watch-party and multi-device features** (rooms, sync, roles, invites,
  chat, voting, polls, reactions, device presence and handoff, delivering
  notifications) — `app`; Multitap stays usable by any client. _Source:
  okf:architecture/goals-and-non-goals._
- **An ACME client or a certificate watcher in Multitap** — basic TLS with
  `SIGHUP` reloads; renewal is an external tool's job, or a reverse proxy's.
  _Source: phase 2 (Decisions)._
- **A central secrets holder** — rejected (2026-10-01) in favour of a `Secret`
  wrapper and per-kind rules. _Source: okf:architecture/secrets-classes-and-engine-password._
- **Redacting a reverse proxy's access logs** — the operator's policy; Multitap
  redacts its own logs. _Source: okf:architecture/secrets-policy._

## Done recently

For context; details in [CHANGELOG.md](CHANGELOG.md).

- [x] **Renamed to Multitap** (2026-10-25): packages, image, CLI,
  environment variables, metrics, `User-Agent`, OpenAPI title, file names and
  wording, with no old names kept (okf:decision/core-public-name-multitap).

- [x] **Multitap adversarial review** (2026-10-20): six areas, 3 high and 30
  medium findings, no critical. Its 8 release blockers were fixed the same
  day (hostile-addon SSRF and ReDoS, atomic migrations with a backup, SSE and
  shutdown, the licence, the `/v1` compatibility check, the deployment-specific
  defaults). On 2026-10-25: open event streams end when their key is
  revoked, Multitap warns about a public plain-HTTP API listener, and
  SECURITY.md. The remaining findings are under
  [Next](#adversarial-review-findings-2026-10). _Source: okf:core-review/summary._

- [x] **Phase 2 marked complete** (2026-10-06). The docker-host
  image run was waived; the standalone TLS routes stay under "Verification
  gaps to close" above, as notes, not blockers. _Source: phase 2._

- [x] **0.1.1** (2026-10-06): safety flags (`destructive` items never
  auto-selected), uncached debrid sources ranked lower, faster recovery when an
  engine returns, an engine connect timeout, Stremio deep links carrying an
  addon URL dropped from meta.
- [x] Engine restart test on the reference deployment (2026-10-05): two restarts recovered without
  manual action, persisted sessions restored. _Source: phase 2._
- [x] Real-addon test against MediaFusion and AIOMetadata (2026-10-06): one
  leak fixed, two findings open (above). _Source: phase 2._
- [x] **0.1.0** (2026-10-04): library writes, profile rename and settings,
  per-request language, the track list and `audioTrack`, `bingeGroup`
  auto-next, streams embedded in meta, manifest hints, addon preview, default
  addons, the addon `User-Agent`, the last source per item, aggregated search,
  subtitle hash extras, `explain`, subtitle `offsetMs`, backups, rotating log
  files. _Source: gap §3; CHANGELOG._
