# Multitap

A standalone headless server built on the Stremio addon protocol. Multitap browses
Stremio addons, lists and ranks their sources for an engine, runs playback sessions on
a streaming engine (a separate torrent and transcoding server, such as stremio-server-go)
and serves their media to any number of players. It holds no app logic of its own: any
client can use it through its `/v1` API.

Changes and the versioning rules: [CHANGELOG.md](CHANGELOG.md). What's still to
do: [ROADMAP.md](ROADMAP.md). Working on Multitap itself: [Developing Multitap](#developing-multitap).

## Why use it

Multitap is a backend built on the Stremio addon protocol, so clients don't need the
full stack (stremio-core, the addons and a streaming server). Use it when:

- **You're building a client:** a TV kiosk, a chat bot or home-automation hook, a
  dedicated fan app or a full player.
- **You want profiles on your own hardware:** library, continue watching and addons,
  shared across devices.
- **You have several engines:** one Multitap in front of all of them (a seedbox for
  torrents, a GPU box for 4K), each registered with what it can do. Picking the
  engine per source on its own is planned.
- **The client can't run the engine or a VPN:** a phone, a smart TV, a browser on a
  work laptop or someone else's device. They only need HTTPS.
- **Credentials should live in one place:** addon manifest URLs can carry keys; with
  Multitap they stay in its database, no client ever sees them, and every fetch
  comes from your servers instead of from each device.
- **You want to give access, not your network:** a VPN puts people inside your
  network. Multitap hands out scoped API keys, or just revocable per-viewer media
  tokens for one playback.
- **The client's network blocks addons or other hosts** (a school, a workplace,
  an ISP or a country): the standard apps run stremio-core on the device, so the
  device itself fetches addons, talks to `api.strem.io`, and often opens external
  URLs directly; a remote streaming server doesn't change that. With Multitap, all
  of it leaves from your servers, and the client needs to reach one hostname:
  Multitap's.
- **Your home has no open ports** (CGNAT): Multitap on a VPS, engines connecting out
  to it (planned; the VPS then relays every media byte).

Multitap has no UI of its own: it's the layer to build your client on. It doesn't
make playback faster or better; the engine transcodes the same way it would for any
other app. It's the API contract that matters.

## What works today

- Addon collection: add by manifest URL, reorder, enable/disable, refresh. Manifest
  URLs are secrets: they're stored in Multitap's database and never returned or logged.
- Catalogs, catalog pages (with the extras each catalog declares), one search across
  every search-capable catalog (`GET /v1/search`, grouped per catalog, a failing addon
  reported rather than fatal), meta, subtitles (converted to WebVTT). Subtitle requests
  carry `videoHash`/`videoSize`/`filename` when known: as query parameters on
  `/v1/subtitles/…`, and found automatically for a session (the stream's hints, else
  the engine's `/opensubHash`).
- Source lists for an engine: every stream the addons return, in addon order like a
  normal Stremio client, or `sort=rank`, optionally incremental (one event per
  addon). Each candidate is annotated with parsed release info,
  `playable`/`unplayableReason`, `playableWhen` and a score. Ranking weights are
  settings (`/v1/admin/ranking`). `explain=true` adds each candidate's score breakdown:
  the rules that moved it (points sum exactly to `score`), the weights used and the
  playability reason. Uncached debrid sources (`[RD download]`, `⏳`) rank below
  cached ones. Items and sources that look like account actions (a debrid
  watchlist's "delete all files" entry) are flagged `destructive` and never
  auto-selected (see [Ranking settings](#ranking-settings)).
- Engines: descriptors with an address, health checks and `online`.
- Playback sessions on an engine: a picked source or auto-select with fallback,
  per-session quality, retention, release.
- Media tokens and the media listener: one HLS URL per viewer, revocable per
  viewer or all at once, with addon subtitles served under the same token.
- `/v1/events` (server-sent events) for session progress and incremental source
  lists.
- Profiles with Stremio-format libraries: progress, continue watching, next
  episode, library writes (add, remove, rewind, mark an item, an episode or a
  season watched), rename, sparse profile settings, the last source played
  for an item, and per-item player state (audio language, subtitle, subtitle
  offset, speed) that seeds a new session.
- Per-request preferred language, an audio and subtitle track list with
  `audioTrack` on a session, `bingeGroup` auto-next (`preferBingeGroup`), and
  streams embedded in an addon's meta.
- Server-side subtitle timing: `offsetMs` per request, or per session
  (`PUT /v1/sessions/{id}/subtitles/{fileId}/offset`).
- Addon management helpers: `POST /v1/admin/addons/preview`, `MULTITAP_DEFAULT_ADDONS`,
  `MULTITAP_ADDON_USER_AGENT`.
- Operations: database backups (`/v1/admin/backups`), rotating log files
  (`MULTITAP_LOG_DIR`), `MULTITAP_API_BIND`/`MULTITAP_MEDIA_BIND`, engine admission control, a bitrate
  derived from `maxHeight`, and an auto-select attempt timeout.
- Scoped API keys (`client`, `admin`, `metrics`) and Prometheus metrics.
- CORS, optional built-in TLS and absolute media URLs, so Multitap needs no reverse
  proxy.

Not built yet: preparation ahead of time (`mode: 'full'`, `readyBy`), direct play
and remux (`delivery: 'direct' | 'remux'`); requests for them get `501`. Known
limits found with real engines and addons (a bad probe cached by the engine,
anime ids that no stream addon accepts), the untested standalone TLS routes and
everything else outstanding are in [ROADMAP.md](ROADMAP.md).

## Running it

Requirements: Node 26 and pnpm 12, from the repository root (`pnpm install`),
and an engine (see [1. An engine](#1-an-engine)).

```bash
pnpm --filter @multitap/core cli api-key create --scope admin --label me
NODE_ENV=development pnpm --filter @multitap/core dev
```

The CLI prints the key once (`--json` prints it as JSON). Multitap listens on
`MULTITAP_API_PORT` (default 8080) for `/v1` and on `MULTITAP_MEDIA_PORT` (default 8081) for
media, and keeps its SQLite database in `MULTITAP_DATA_DIR` (default `./data`,
git-ignored). The CLI also has `api-key list` and `api-key revoke <id>`.

[Standalone use](#standalone-use-end-to-end) below walks through playing
something end to end.

With `NODE_ENV=development`, `http://localhost:8080/dev` is a throwaway page for
browsing catalogs, meta and source lists with a key, and for playing a source:
**Play** on a candidate (or **Play (auto-select)**) creates a session, follows it
on `/v1/events`, mints a media token when it's ready and plays it with hls.js
(served from `node_modules` at `/dev/hls.mjs`, development only; no CDN). It loads
the session's addon subtitles as `<track>`s, can add a second player with its own
token, and revokes one subject or every token, so a player stops with a `404`.

The page is on the API port and media is on the media port, so its playback is
cross-origin like any real client's: Multitap must allow the page's origin, and media
comes from `MULTITAP_MEDIA_PUBLIC_BASE` when set, else from `MULTITAP_MEDIA_PORT` on the host the
page was opened by. The page warns when its origin isn't allowed.

```bash
NODE_ENV=development MULTITAP_CORS_ORIGINS=http://localhost:8080 pnpm --filter @multitap/core dev
```

## Standalone use, end to end

Everything below uses `curl` and `jq` against Multitap on `localhost`, from Git
Bash or a Linux shell. The same calls are available, typed, from the generated
client (`createMultitapClient` in `@multitap/api`, see [API](#api)).

### 1. An engine

Multitap plays through a streaming engine: a separate server that adds torrents,
fetches HTTP sources and transcodes them to HLS. Multitap isn't tied to one engine.
It's developed and tested with [stremio-server-go](https://github.com/M0Rf30/stremio-server-go)
v0.18.1 or later (or `main`), so far the only engine tested, and the settings below
are that engine's. Another engine has to serve the same endpoints the same way
([what Multitap uses](knowledge/architecture/engine-endpoints-core-uses.md)).
Multitap detects the optional engine features at runtime.

Treat the engine as having **no authentication** (stremio-server-go has none): only
Multitap may reach it, so never expose its port. Run it on the same host as Multitap
(for stremio-server-go, `BIND_ADDRESS=127.0.0.1`) or on a LAN address that a
firewall opens to Multitap's host only.

stremio-server-go settings Multitap relies on:

| Variable | Value | Why |
|---|---|---|
| `STREMIO_HLS_SESSION_TTL` | `0` | Multitap releases engine sessions itself (`DELETE`) |
| `STREMIO_HLS_SESSION_OVERRIDES` | `1` | Per-session quality; set the engine's `sessionOverrides` capability to match |
| `STREMIO_HLS_PERSIST` | `1` | Engine sessions survive an engine restart |
| `STREMIO_TRANSCODE_TONEMAP` | `on` | HDR to SDR (needs ffmpeg with `zscale`); set `tonemap` to match |
| `STREMIO_HLS_SEGMENT_TIMEOUT` | e.g. `180s` | Keep Multitap's `MULTITAP_ENGINE_TIMEOUT_MEDIA_MS` above it |
| `STREMIO_PROXY_PASSWORD` | random | Optional; if set, give Multitap the same value (below) |

Multitap starts with **no engine**: until an admin adds one, source lists and
sessions answer `400` saying so, and Multitap logs a warning at startup. Add one
with its address and what its hardware can do:

```bash
curl -X PUT localhost:8080/v1/admin/engines/main -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{
    "name": "Main", "transport": "lan", "address": "http://127.0.0.1:11470",
    "capabilities": { "hwaccel": "none", "liveMaxHeight": 1080, "preparedMaxHeight": 2160,
      "tonemap": true, "sessionOverrides": true, "liveConcurrency": 1, "prepareConcurrency": 1 }
  }'
```

The capabilities are declared, not probed, and ranking and admission trust them (the
variables named are stremio-server-go's):

| Capability | Meaning |
|---|---|
| `hwaccel` | The engine's hardware acceleration: `none` (software x264), `qsv`, `nvenc` or `vaapi` |
| `liveMaxHeight` | Tallest source it transcodes live. Taller sources are unplayable (`too-high`), or with `highRes` playable only once prepared, which isn't built yet. Use what the box keeps up with in real time |
| `preparedMaxHeight` | Tallest source it could prepare ahead of time |
| `tonemap` | It tone-maps HDR to SDR (`STREMIO_TRANSCODE_TONEMAP`); without it HDR sources rank lower |
| `sessionOverrides` | It accepts per-session quality (`STREMIO_HLS_SESSION_OVERRIDES=1`); without it Multitap sends none |
| `liveConcurrency` | Live sessions it can transcode at once. Multitap compares it with the sessions actually playing and warns past it (or, with `MULTITAP_ENGINE_ADMISSION=reject`, refuses with `503`) |
| `prepareConcurrency` | Preparation jobs at once |
| `defaultBitrate` | Optional: the engine's `STREMIO_TRANSCODE_VIDEO_BITRATE`; a bitrate Multitap derives from `maxHeight` never exceeds it |

A request that names no engine uses `MULTITAP_SELECTION_DEFAULT_ENGINE`, or, when that is
unset, the only engine there is; with several engines and no default it must
name one. The engine `MULTITAP_SELECTION_DEFAULT_ENGINE` names can't be deleted. Multitap
health-checks every engine with an address (`ENGINE_HEALTH_*`), and re-checks
an offline engine as soon as it answers any request; `GET /v1/admin/engines`
shows `online` and `lastSeen`.

**The engine's proxy password.** Sources with `proxyHeaders` play through the
engine's `/proxy/stream`. On an engine that sets `STREMIO_PROXY_PASSWORD`, give
Multitap the same value, or those sources fail their probe (`probe-failed`, with a
log hint). It's write-only: set it from a file with the CLI, so it stays off
command lines,

```bash
pnpm --filter @multitap/core cli engine proxy-password main --file proxy-password.txt
# docker exec multitap multitap engine proxy-password main --file /run/secrets/proxy-password
# --clear removes it
```

or add `"proxyPassword": "…"` to the `PUT /v1/admin/engines/main` body. A `PUT`
without the field keeps the stored password, `""` or `null` clears it, and
responses show only `proxyPasswordSet`. It applies to the next engine request;
no restart.

### 2. API keys

```bash
pnpm --filter @multitap/core cli api-key create --scope admin   --label me          # everything
pnpm --filter @multitap/core cli api-key create --scope client  --label my-player   # browse, sessions, tokens, profiles, events
pnpm --filter @multitap/core cli api-key create --scope metrics --label prometheus  # GET /metrics only
```

`GET /v1/whoami` tells a `client` or `admin` key which key it is (id, scope,
label, `createdAt`, `lastUsed`; never the key itself). `admin` keys can also
create and revoke keys through `/v1/admin/api-keys`. The
examples below use `$ADMIN_KEY` for admin routes and `$KEY` (a `client` key)
for the rest.

### 3. Addons

```bash
curl -X POST localhost:8080/v1/admin/addons -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"manifestUrl":"https://v3-cinemeta.strem.io/manifest.json"}'
curl localhost:8080/v1/admin/addons -H "Authorization: Bearer $ADMIN_KEY"
```

Add a streams addon the same way. Its manifest URL may carry a debrid key: Multitap
keeps it in its database and never returns or logs it. `PUT
/v1/admin/addons/order`, `PATCH /v1/admin/addons/{id}` (enable/disable) and the
refresh routes manage the collection.

### 4. Sources

```bash
curl "localhost:8080/v1/streams/movie/tt1375666?sort=rank" -H "Authorization: Bearer $KEY" \
  | jq '.candidates[] | {key, title, playable, score}'
```

The list is ranked for the default engine (`?engine=` for another). Each
candidate's `key` is what a session plays; keys stay valid for
`MULTITAP_STREAM_STORE_TTL_MS` (6 h), and an expired one gets `409`. They're kept in
memory only, so after a Multitap restart the sources must be listed again (sessions
and tokens survive). For an episode the
video id is `{id}:{season}:{episode}`. With `?incremental=true` the answer is a
`202` with a `requestId`, and each addon's candidates arrive as a
`streams.partial` event on `/v1/events?request={requestId}`.

### 5. A session

With a picked candidate (no fallback: if it can't play, the session fails, as in
Stremio):

```bash
SID=$(curl -s -X POST localhost:8080/v1/sessions -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"item\":{\"type\":\"movie\",\"id\":\"tt1375666\"},\"source\":{\"key\":\"$CANDIDATE_KEY\"}}" | jq -r .id)
```

Or let Multitap choose: `"source":{"auto":true}` ranks the sources for the engine
and tries the playable ones in order, up to `MULTITAP_AUTO_SELECT_MAX_ATTEMPTS`, giving
each `MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS` (45 s). Optional
fields: `quality: {maxHeight, bitrate}` (capped at the engine's `liveMaxHeight`
and `MULTITAP_SESSION_MAX_BITRATE`; with `maxHeight` alone Multitap derives the bitrate from
`MULTITAP_SESSION_BITRATE_BY_HEIGHT`, e.g. 3 Mb/s for 720p, and the session's `quality`
shows it; needs an engine with `sessionOverrides`), `engine`,
`retainUntil`, and `key`, a grouping key that makes the create idempotent (the
same key, item, source, delivery and quality return the open session with
`200`). For an episode add `"videoId":"tt0903747:1:1"` to `item`.

The answer comes at once (`201`) with `status: "resolving"`; the engine work
(torrent metadata, probe, first segments) runs in the background. Follow it on
the event stream, or poll `GET /v1/sessions/$SID` until `status` is `ready` or
`failed` (`failureReason` says why).

```bash
curl -N "localhost:8080/v1/events?session=$SID" -H "Authorization: Bearer $KEY"
# event: session.status   data: {..."data":{"status":"resolving","progress":{"phase":"probing"}}}
# event: session.ready    data: {..."data":{"session":{...,"status":"ready"}}}
```

Events are `session.status`, `session.ready`, `session.failed`,
`session.released` and `streams.partial` (plus `settings.changed` and
`engine.status` for admin keys). Filter with `session`, `request` or `types`
(comma-separated); after a reconnect, `Last-Event-ID` replays missed events from
a bounded buffer, and the `X-Events-Replay` header says whether the replay was
`complete`.

A session is kept until `max(retainUntil, last access + MULTITAP_RETENTION_IDLE_MS)`;
`PATCH /v1/sessions/$SID` sets `retainUntil`, and `DELETE /v1/sessions/$SID`
releases it at once (its media then answers `410`).

### 6. A media token

Each viewer gets its own token, named by a `subject` you choose:

```bash
curl -s -X POST localhost:8080/v1/sessions/$SID/tokens -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"subject":"living-room"}'
# {"token":"eyJ…","subject":"living-room","sessionId":"ps_…",
#  "mediaPath":"/media/eyJ…/master.m3u8","mediaUrl":"http://localhost:8081/media/eyJ…/master.m3u8","exp":"…"}
```

The token is a bearer credential in the URL path: treat `mediaUrl` like a
password. `mediaUrl` is present when `MULTITAP_MEDIA_PUBLIC_BASE` is set; otherwise use
`mediaPath` on the media listener. Tokens last `MULTITAP_MEDIA_TOKEN_TTL_MS` (8 h) unless
the request sets `ttl` in seconds (at most `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS`). A token
minted before the session is ready gets `404` on media until it is. Set
`MULTITAP_MEDIA_TOKEN_SECRET` (or `MULTITAP_MEDIA_TOKEN_SECRET_FILE`): without it Multitap signs with
a random key per process, and every token dies on restart.

On media, an expired token gets `401` (mint a new one and reload the master at
the current position), a released session `410`, and anything else that can't
be served `404`. `DELETE /v1/sessions/$SID/tokens/living-room` revokes one
viewer (that subject can't be minted again on this session until its tokens
would have expired); `POST /v1/sessions/$SID/tokens/revoke-all` revokes
everyone. `GET /v1/sessions/$SID/viewers` shows each subject's last file and
bytes sent, and `GET /v1/sessions/$SID/subtitles` lists the item's addon
subtitles with paths to load as `/media/{token}/{path}`.
Subtitle timing can be fixed server-side so no viewer has to set a player delay:
`PUT /v1/sessions/$SID/subtitles/$FILE/offset` with `{"offsetMs": -1500}` shifts that
track for everyone on the session (signed milliseconds, positive later, at most 600000
either way; `DELETE` or `0` clears it; it survives a restart), and a media request can add
`?offsetMs=` on top. A cue pushed before 0 is clamped, one ending at or before 0 is dropped.

Two tokens on one session share its one engine session and transcode.

### 7. Play it from a plain hls.js page

Save this as `player.html`, serve it from any origin that is in `MULTITAP_CORS_ORIGINS`,
and open it with the token's `mediaUrl` after `#`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Multitap player</title>
<video id="video" controls crossorigin="anonymous" style="width: 100%"></video>
<script type="module">
  import Hls from 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.mjs';
  // The URL is in the fragment, which the browser never sends to a server.
  const src = decodeURIComponent(location.hash.slice(1));
  const video = document.getElementById('video');
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src; // Safari plays HLS natively
  }
</script>
```

```bash
python -m http.server 5500     # in the directory holding player.html
# Multitap started with MULTITAP_CORS_ORIGINS=http://localhost:5500 MULTITAP_MEDIA_PUBLIC_BASE=http://localhost:8081
# open http://localhost:5500/player.html#<mediaUrl>
```

Seeking and pausing are the player's own: every segment is a separate engine
request, so a seek plays from the new position after the first segment there is
transcoded. Subtitles go in as `<track kind="subtitles" src="…/media/{token}/ext/sub/….vtt">`
(the `<video>` needs `crossorigin`). The `/dev` page above is a fuller version
of this.

### 8. Profiles, progress and the library

```bash
PID=$(curl -s -X POST localhost:8080/v1/profiles -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"name":"Living room"}' | jq -r .id)
curl -X POST localhost:8080/v1/profiles/$PID/progress -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"item":{"type":"series","id":"tt0903747"},"videoId":"tt0903747:1:1","time":1234000,"duration":2820000,"event":"pause"}'
curl localhost:8080/v1/profiles/$PID/continue -H "Authorization: Bearer $KEY"
curl localhost:8080/v1/profiles/$PID/next/series/tt0903747 -H "Authorization: Bearer $KEY"
curl -X PATCH localhost:8080/v1/profiles/$PID -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"settings":{"audioLanguage":"ita","bingeWatching":false}}'
```

A session isn't tied to a profile: the client reports positions (milliseconds)
to whichever profiles it wants. Multitap applies stremio-core's rules: watched past
70 %, moving on to the next episode when stopped past 90 %, the
watched-episodes bitfield, and writes at most every 90 s while playing (at once
on `pause`, `stop`, `ended` or another item). Report a seek with
`"event":"seek"`, or the jump counts as time watched. `GET
/v1/profiles/$PID/library` lists every item in stremio-core's `LibraryItem`
shape.

A profile's `settings` are stremio-core's per-profile settings (its field names
and defaults) for what a headless client uses: languages, subtitle style,
`bingeWatching`, seek steps and a few more, plus a `client` bag (any JSON, at
most 16 KiB) for the rest. `PATCH /v1/profiles/$PID` renames and changes them;
unknown typed fields are a `400`. Pass `profileId=$PID` to `GET /v1/streams/…`
and `"profileId"` to `POST /v1/sessions` to rank with the profile's audio
languages (a request's own `preferredLanguage` still wins; with no
`audioLanguage` set, `MULTITAP_SELECTION_PREFERRED_LANGUAGE` applies). A session created
with `profileId` also records its source as the item's `lastSource` once ready
(shown on library and continue-watching items); later lists for the profile
flag it `lastUsed` and auto-select prefers it while the addons still offer it.
Multitap never auto-plays the next episode; `bingeWatching` is for clients.

A profile also keeps per-item player state (stremio-core's `StreamItemState`):
`PUT /v1/profiles/$PID/items/movie/tt0000001/state` with, for example,
`{"audioLanguage":"ita","subtitle":{"kind":"addon","lang":"eng","addonId":"…","fileId":"…"},"subtitleOffsetMs":-1500}`
stores the choices (fields left out are kept, null clears one), and `GET` reads
them back; library items show them as `playerState`. A session created with
`profileId` and no `audioLanguage` starts with the stored one, and with the
stored offset on the chosen addon subtitle file.

### 9. Ranking

`GET /v1/admin/ranking` shows the effective ranking settings, and `PATCH` changes
some of them, for example `-d '{"language":{"matchBonus":150}}'`. See
[Ranking settings](#ranking-settings).

### 10. Exposing it: CORS, TLS and the media URL

Multitap needs no reverse proxy:

- `MULTITAP_CORS_ORIGINS`: the exact browser origins allowed on both listeners. A page
  on another origin gets no CORS headers, so its browser blocks the media.
- `MULTITAP_MEDIA_PUBLIC_BASE`: the absolute base of the media listener as players reach
  it (`https://media.example.org`). Set it whenever the media listener is
  public; Multitap warns at startup when CORS is on and it isn't set.
- `MULTITAP_TLS_CERT_FILE` / `MULTITAP_TLS_KEY_FILE`: Multitap serves HTTPS on both listeners itself.
- Keep the API listener private (API keys are full credentials) and expose
  only the media listener, which serves nothing but `/media/{token}/…`. Port
  8080 must never be reachable from outside: on a bare host, bind it to
  loopback or an internal interface with `MULTITAP_API_BIND` (`MULTITAP_MEDIA_BIND` does the
  same for media, e.g. behind a proxy on the same host). Multitap warns at
  startup when the API listens on a non-loopback address over plain HTTP. In
  a container it listens on every interface, so the warning is expected
  there as long as the port isn't published.

The threat model, what counts as a vulnerability and how to report one are
in [SECURITY.md](SECURITY.md).

### Docker

The image is `ghcr.io/multitap-media/multitap`, for amd64 and arm64, tagged
`X.Y.Z`, `X.Y` and `latest` on every release. For a deployment you keep, pin
`X.Y.Z` (or `X.Y` to follow its patch releases) rather than `latest`:

```bash
docker run -d --name multitap -v multitap-data:/data -p 127.0.0.1:8080:8080 -p 8081:8081 ghcr.io/multitap-media/multitap:latest
docker exec multitap multitap api-key create --scope admin --label me
```

To build it yourself instead, run `docker build -t multitap .` from the
repository root and use `multitap` as the image name.

Then add an engine, as in [1. An engine](#1-an-engine) (`docker exec` reaches
the API on loopback). The image's health check calls
`http://127.0.0.1:$MULTITAP_API_PORT/healthz` and falls back to `https://` on loopback,
so it works with built-in TLS too.

## Configuration

Environment variables, validated at startup (`src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `MULTITAP_API_PORT` | `8080` | `/v1` listener |
| `MULTITAP_API_BIND` | unset (all interfaces) | Address the `/v1` listener binds (IP or host name), e.g. `127.0.0.1` when nothing else on the host needs the API. Never expose it to the outside. Leave unset in Docker: the image's health check calls `127.0.0.1` |
| `MULTITAP_DATA_DIR` | `./data` | SQLite database |
| `NODE_ENV` | `production` | `development` enables pretty logs and `/dev` |
| `MULTITAP_LOG_LEVEL` | `info` | pino level |
| `MULTITAP_LOG_DIR` | unset | Also write JSON logs to rotating files `multitap.<date>.<n>.log` in this directory (pino-roll): daily, and by size. Unset = stdout only. Redaction is the same as on stdout; at `debug`/`trace` the files contain credentials too |
| `MULTITAP_LOG_STDOUT` | `true` | Also log to stdout; `false` needs `MULTITAP_LOG_DIR` |
| `MULTITAP_LOG_FILE_KEEP` / `MULTITAP_LOG_FILE_MAX_SIZE` | 7 / `50M` | Rotated files kept besides the current one; size at which a file rotates (`512k`, `50M`, `1G`) |
| `MULTITAP_BACKUP_DIR` | `<MULTITAP_DATA_DIR>/backups` | Where database backups go (see Backups). They contain secrets |
| `MULTITAP_BACKUP_INTERVAL_MS` | `0` (off) | Back up on a timer (at least 60000), e.g. `86400000` daily |
| `MULTITAP_BACKUP_KEEP` | 7 | Backups kept, scheduled and manual alike; the oldest are pruned |
| `MULTITAP_SELECTION_DEFAULT_ENGINE` | unset (the only engine) | Engine used when a request doesn't name one; unset means the only engine there is. The engine it names can't be deleted |
| `MULTITAP_SELECTION_DEFAULT_HIGH_RES` | `off` | Sources above the engine's `liveMaxHeight`: `off` marks them unplayable, `prepareOnly` or `on` playable once prepared (a request's `highRes` wins) |
| `MULTITAP_SELECTION_PREFERRED_LANGUAGE` | `eng` | ISO 639-2 language favoured by ranking, when a request names none (`preferredLanguage`) |
| `MULTITAP_ADDON_TIMEOUT_CATALOG_MS` / `_META_MS` / `_STREAMS_MS` / `_SUBTITLES_MS` | 5000 / 5000 / 10000 / 5000 | Per-addon request timeouts |
| `MULTITAP_ADDON_MANIFEST_REFRESH_MS` | 6 h | Manifest refresh interval |
| `MULTITAP_ADDON_RESPONSE_CACHE_ENTRIES` | 1000 | Response cache size (honours addon cache hints) |
| `MULTITAP_ADDON_TIMEOUT_MANIFEST_MS` | 10000 | Manifest fetch timeout |
| `MULTITAP_ADDON_CIRCUIT_FAILURES` / `MULTITAP_ADDON_CIRCUIT_RESET_MS` | 5 / 60000 | Addon circuit breaker: consecutive failures before it opens, and how long it stays open |
| `MULTITAP_ADDON_USER_AGENT` | `Multitap/<version> (+https://multitap.dev)` | `User-Agent` of addon requests |
| `MULTITAP_DEFAULT_ADDONS` | empty | Comma-separated manifest URLs installed once at start, only when no addon is installed. Secret like any manifest URL; none are built in |
| `MULTITAP_ADDON_PRIVATE_ALLOW` | empty | Comma-separated IPs, CIDRs and host names that addon redirects and subtitle files may reach although they are private (LAN addons and subtitle hosts). Everything else private, loopback or metadata is refused |
| `MULTITAP_STREAM_STORE_TTL_MS` | 6 h | How long a source list's candidate keys stay valid; older keys get `409` on session create |
| `MULTITAP_SUBTITLE_TIMEOUT_MS` / `MULTITAP_SUBTITLE_MAX_BYTES` | 10000 / 5 MiB | Fetching one addon subtitle file |

Sessions, media and engines:

| Variable | Default | Purpose |
|---|---|---|
| `MULTITAP_MEDIA_PORT` | `8081` | `/media` listener (must differ from `MULTITAP_API_PORT`) |
| `MULTITAP_MEDIA_BIND` | unset (all interfaces) | Address the `/media` listener binds, e.g. `127.0.0.1` behind a proxy on the same host |
| `MULTITAP_MEDIA_TOKEN_SECRET` / `MULTITAP_MEDIA_TOKEN_SECRET_FILE` | unset | Media token signing key, at least 32 bytes; set one, not both. Unset: a random key per process, with a warning (tokens die on restart) |
| `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS` | unset | Old key still accepted while rotating |
| `MULTITAP_MEDIA_TOKEN_TTL_MS` / `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS` | 8 h / 7 days | Default and longest media token lifetime |
| `MULTITAP_MEDIA_PUBLIC_BASE` | unset | Absolute base for `mediaUrl` (e.g. `https://media.example.org`); set it whenever the media listener is public |
| `MULTITAP_CORS_ORIGINS` | empty | Exact browser origins, comma-separated; empty = no CORS headers |
| `MULTITAP_TLS_CERT_FILE` / `MULTITAP_TLS_KEY_FILE` | unset | Built-in TLS on both listeners; set both or neither. Basic (self-signed in mind, no ACME, no file watcher): `SIGHUP` re-reads both files for new connections, and a failed reload keeps the old pair and logs a warning. Windows has no `SIGHUP`: restart Multitap there |
| `MULTITAP_SESSION_MAX_BITRATE` | `20M` | Ceiling for a session's `quality.bitrate` (`20M`, `800k` or bits per second), and for a derived one. A plain ceiling: raise it (e.g. `50M`) when the upload allows |
| `MULTITAP_SESSION_BITRATE_BY_HEIGHT` | `240=600k,360=1M,480=1.5M,576=2M,720=3M,1080=6M,1440=10M,2160=16M` | The bitrate Multitap sends for a `quality` with `maxHeight` and no `bitrate`: the first rung at or above the (capped) height, else the top one, at most `MULTITAP_SESSION_MAX_BITRATE` and the engine's `defaultBitrate`. `off` sends none, so the engine's own bitrate applies at every height |
| `MULTITAP_RETENTION_IDLE_MS` | 1 h | A session is kept until max(retainUntil, last access + this) |
| `MULTITAP_SESSION_RELEASED_KEEP_MS` / `MULTITAP_RETENTION_SWEEP_MS` | 24 h / 60000 | How long released sessions answer `410`; retention sweep interval |
| `MULTITAP_AUTO_SELECT_MAX_ATTEMPTS` / `MULTITAP_AUTO_SELECT_RETRY_AFTER_MS` | 5 / 30000 | Auto-select: failures before giving up; wait before retrying a failed torrent once |
| `MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS` | 45000 | Auto-select: a candidate not ready by then is abandoned (its engine calls aborted) and the next one tried; `0` = no limit, else at least 5000. A picked source keeps the engine timeouts |
| `MULTITAP_ENGINE_ADMISSION` | `warn` | A new session on an engine whose resolving and playing sessions already reach its `liveConcurrency`: `off`, `warn` (log a warning, go ahead) or `reject` (`503` with `Retry-After`) |
| `MULTITAP_ENGINE_LOAD_WINDOW_MS` | 60000 | A ready session counts as playing for this long after its last segment request (engine load, the `multitap_engine_load_sessions` gauge) |
| `MULTITAP_ENGINE_HEALTH_INTERVAL_MS` / `_TIMEOUT_MS` / `_MAX_BACKOFF_MS` | 30000 / 5000 / 60000 | Engine health checks: interval while online, timeout, longest backoff while offline (also caps the retry of failed engine deletes). An offline engine that answers any request is re-checked at once |
| `MULTITAP_ENGINE_CONNECT_TIMEOUT_MS` | 3000 | Connect timeout (TCP and TLS) of engine requests, 100–60000: a stopped engine host that drops connections fails fast (`engine-offline`) instead of after 10 s. The per-call timeouts below still apply |
| `MULTITAP_ENGINE_SESSION_TTL_MS` | unset | Per-session engine `ttl` sent to engines with `sessionOverrides`, a safety net for sessions Multitap never manages to delete (e.g. `172800000`, 48 h). 60 s–30 d and at least `MULTITAP_RETENTION_IDLE_MS`; unset sends none. Failed engine deletes are retried by the retention sweep either way |
| `MULTITAP_ENGINE_TIMEOUT_CONTROL_MS` / `_PREPARE_MS` / `_MEDIA_MS` | 10000 / 150000 / 200000 | Engine calls: stats and deletes; create, probe and the creating master request; playlists and segments (keep it above the engine's segment timeout, stremio-server-go's `STREMIO_HLS_SEGMENT_TIMEOUT`) |
| `MULTITAP_EVENTS_REPLAY_SIZE` / `MULTITAP_EVENTS_HEARTBEAT_MS` | 1000 / 15000 | `/v1/events` replay buffer and heartbeat |

### Ranking settings

Every number the source-list ranking uses is a setting in
the database, not an environment variable. `GET /v1/admin/ranking` (admin key)
shows the effective values, the defaults and the stored overrides; `PATCH`
changes some, `PUT` replaces all (the `effective` object of a `GET` is a
complete preset to import elsewhere), `DELETE` resets. Only values that differ
from the defaults are stored, so later default changes still reach the rest.
Writes are validated whole (an invalid body stores nothing), apply to the next
source list without a restart, and emit `settings.changed`. Scores are sums of
these; higher is better, penalties are subtracted.

| Group | Setting | Default | Meaning |
|---|---|---|---|
| `tiers` | `debridCached` / `http` / `healthyTorrent` / `weakTorrent` | 4000 / 3000 / 2000 / 1000 | Source tier: debrid-cached, plain HTTP (and YouTube, live, and an uncached debrid link before its penalty), a torrent with enough seeders, a weak torrent |
| | `healthySeeders` | 10 | Seeders for a healthy torrent |
| | `seedersLogPoints` / `seedersMaxPoints` | 100 / 300 | Healthy torrents: + this × log10(seeders), capped |
| | `weakSeederPoints` | 20 | Weak torrents: + this per seeder |
| `hdr` | `noTonemapPenalty` | 1500 | HDR on an engine without tone mapping |
| | `tonemapCostLive` / `tonemapCostPrepared` | 300 / 100 | Tone mapping's CPU cost |
| | `dvUnknownProfilePenalty` | 1000 | Dolby Vision with no stated profile (might be profile 5, which plays with wrong colours) |
| `decodeCost` | `h264_8bit` / `h264_10bit` / `hevc_8bit` / `hevc_10bit` / `vp9` / `av1` / `legacy` / `unknown` | 0 / 150 / 100 / 200 / 300 / 400 / 50 / 150 | Software decode cost per codec (`legacy`: MPEG-2, Xvid, VC-1) |
| `container` | `mpegtsLivePenalty` / `otherPenalty` | 150 / 25 | MPEG-TS on a live session; anything but MKV/MP4 |
| `size` | `perResolution.{2160p,1080p,720p,sd}.minMbPerMinute` | 30 / 11.25 / 6 / 2.25 | Below this many MB (10^6 bytes) per minute of runtime is implausibly small (`sd`: below 720p or unknown) |
| | `perResolution.*.maxMbPerMinute` | 300 | Above this is too large to fetch live |
| | `tooSmallPenalty` / `tooLargeLivePenalty` | 300 / 100 | The size penalties |
| | `noRuntimeMinMiB` | 100 | Without any runtime, smaller files count as too small |
| `language` | `matchBonus` / `mismatchPenalty` | 100 / 200 | The preferred audio language is present / known languages lack it |
| `resolution` | `points.{2160p,1080p,720p,480p,lower}` | 300 / 300 / 200 / 100 / 0 | Points by height, capped at the engine's `liveMaxHeight` |
| | `unknownPoints` | 100 | Height unknown |
| `release` | `junkPenalty.{cam,telesync,telecine,screener,workprint}` | 2500 each | Pre-release junk |
| | `preparedOnlyPenalty` | 200 | Plays only once prepared |
| | `episodeMismatchPenalty` | 10000 | Same show, another episode: below every matching playable candidate |
| | `titleMismatchPenalty` | 20000 | A different title |
| `binge` | `matchBonus` | 5000 | The candidate's `bingeGroup` is the request's `preferBingeGroup` (auto-next) |
| `lastSource` | `matchBonus` | 4000 | The source the request's profile last played for this video (`lastUsed`) |
| `debrid` | `uncachedPenalty` | 2000 | A debrid link the addon marks as not cached (`[RD download]`, an hourglass `⏳`): ranks below healthy cached and torrent sources, still playable |
| `safety` | `titlePatterns` | `delete all`, `remove all`, `clear all`, `wipe`, `purge all`, `format` | Plain phrases (whole words, any case) in an item's name or a source's name or description that flag it `destructive` |
| | `idPrefixes` | none | Item ids starting with one of these are flagged `destructive`, with all their sources |

**Flagged items** carry `flags: ["destructive"]` in catalogs, search, meta and
source lists (`explain` names the matching setting). Nothing is hidden and
scores don't change, but auto-select never picks a flagged source: with only
flagged ones the session fails with `only-flagged`. A source picked by key
still plays, with a warning in the log. A `PUT` preset may leave out `binge`,
`lastSource`, `debrid` and `safety`; they take the defaults. Lists replace
whole on `PATCH`, for example
`-d '{"safety":{"idPrefixes":["someprefix"]}}'`.

Mismatches use the item's meta (name, year, episode, runtime), looked up through
the addons for movies and series alongside the streams and cached for an hour.
Season and complete packs that contain the episode are not penalised. A title
counts as different only when no release line names the item (case, accents,
punctuation and a leading article ignored), none states its year, and the
exact episode isn't stated; translated or romanized names without either
(e.g. `Shingeki no Kyojin` for Attack on Titan) still score as different.

### Logs and secrets

Logs go to stdout. With `MULTITAP_LOG_DIR` they are also written as JSON to rotating
files (`multitap.<yyyy-MM-dd>.<n>.log`, a new file daily and when one reaches
`MULTITAP_LOG_FILE_MAX_SIZE`, `MULTITAP_LOG_FILE_KEEP` rotated files kept) by
[pino-roll](https://github.com/mcollina/pino-roll); `MULTITAP_LOG_STDOUT=false` turns
stdout off. The files carry exactly what stdout would, redaction included.

At `info` and above Multitap redacts secrets from its logs: API keys, addon manifest
URLs, stream URLs, raw streams, engine `mediaURL`s and media tokens. At `debug`
and `trace` it redacts **nothing**, so you can see exactly what Multitap sent and
received, and it logs a warning at startup saying so (with `MULTITAP_LOG_DIR` set, the
warning adds that the log files will contain credentials). Debug logs therefore contain
credentials: treat them as secret and never share them.

The media listener logs each request at `info` with the session id and subject
from the verified token, never the path (which holds the token). A proxy in
front of it should drop the path from its access log too; that's the
operator's policy. Multitap never returns raw streams, stream URLs or engine
`mediaURL`s; they live only in its database. An engine's own request log can
record `mediaURL`s, debrid tokens included (stremio-server-go's does, with
`STREMIO_HTTP_LOG=1`).

### Backups

The database is in WAL mode, so copying `multitap.sqlite` while Multitap runs is unsafe.
Use the admin API, which takes a consistent online backup, verifies it with
`PRAGMA integrity_check` and prunes beyond `MULTITAP_BACKUP_KEEP`:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8080/v1/admin/backups
# {"id":"multitap-20260930T203015123Z","createdAt":"…","sizeBytes":…,"kind":"manual"}
curl -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8080/v1/admin/backups
curl -H "Authorization: Bearer $ADMIN_KEY" -o multitap.sqlite \
  http://localhost:8080/v1/admin/backups/multitap-20260930T203015123Z
curl -X DELETE -H "Authorization: Bearer $ADMIN_KEY" \
  http://localhost:8080/v1/admin/backups/multitap-20260930T203015123Z
```

Set `MULTITAP_BACKUP_INTERVAL_MS` for scheduled backups (`kind: "scheduled"`); a failed
one logs a warning and leaves the older backups alone. Metrics:
`multitap_backup_last_success_timestamp_seconds`, `multitap_backup_outcomes_total`.

**Treat backups as secrets.** They hold engine proxy passwords, stored raw
streams (which can carry debrid keys) and hashed API keys. Files are created
with mode `0600` in a `0700` directory where the platform supports modes
(Windows ignores them: protect `MULTITAP_BACKUP_DIR` with its folder permissions). Copy
them off the machine, but not anywhere you wouldn't keep the database.

**Restore:** stop Multitap, replace `multitap.sqlite` in `MULTITAP_DATA_DIR` with the backup,
delete the stale `multitap.sqlite-wal` and `multitap.sqlite-shm` beside it, start Multitap.
Migrations newer than the backup run at startup.

## API

The API is schema-first: routes are declared with zod in
`src/http/routes/`, and the OpenAPI 3.1 document is generated from them into
[`packages/api/openapi.json`](packages/api/openapi.json), along with
a typed client (`createMultitapClient` in `@multitap/api`).

- Authentication: `Authorization: Bearer <key>`. A missing or invalid key gets the
  same `404` as an unknown path; a key without the needed scope gets `403`.
  Scopes: `client` (browse, sessions, tokens, profiles, events), `admin`
  (everything, including `/v1/admin/*`), `metrics` (only `/metrics`).
- Errors are RFC 9457 problem JSON.
- `/healthz` needs no key. `/openapi.json` needs a `client` key. `/metrics`
  (Prometheus text) needs a `metrics` or `admin` key.
- `/v1/admin/backups` (create, list, download, delete): database backups, see Backups.
- The media listener (`MULTITAP_MEDIA_PORT`) serves only `/media/{token}/…` and needs no
  key: the token is the credential.

A typed client, from inside this workspace:

```ts
import { createMultitapClient } from '@multitap/api';

const multitap = createMultitapClient({ baseUrl: 'http://localhost:8080', apiKey: process.env.KEY! });
const { data: session } = await multitap.POST('/v1/sessions', {
  body: { item: { type: 'movie', id: 'tt1375666' }, source: { auto: true } },
});
// …wait for session.ready (events) or poll GET /v1/sessions/{id}, then:
const { data: token } = await multitap.POST('/v1/sessions/{id}/tokens', {
  params: { path: { id: session!.id } },
  body: { subject: 'living-room' },
});
console.log(token!.mediaUrl ?? token!.mediaPath);
```

After changing a route, run `pnpm run api:generate` and commit both generated files.

### Versioning

The path carries the major version, and the document's `info.version` is
Multitap's release. `/v1` changes are additive by default: new routes, optional
request fields and new response fields. Each change is checked against the
last release (`pnpm run api:diff`, part of `pnpm run ci`). While Multitap is
`0.x`, a breaking `/v1` change ships only in a minor release (`0.1.x` to
`0.2.0`) with a "Breaking changes" entry in [CHANGELOG.md](CHANGELOG.md), so a
client that pins a minor version gets none. From `1.0`, `/v1` takes no
breaking changes; they go to `/v2`. Tolerate new fields and, in
`failureReason`-style strings, new values.

## Licence

Multitap's server (`packages/core`) and its container image are licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). You may run, change
and share it. If you run a changed Multitap for other people over a network, you
must offer those people the source of your version (section 13). Running an
unchanged Multitap needs nothing more.

The client packages, `@multitap/api` (schemas, OpenAPI document, typed client)
and `@multitap/addon-protocol` (addon protocol types and client), are
[MIT](packages/api/LICENSE), so apps and players built on the API can
use any licence. Contributions are signed off under the DCO, with no
contributor licence agreement ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Developing Multitap

The design is in this repository's knowledge bundle, starting at
[knowledge/project-map.md](knowledge/project-map.md) (`okf:` references in
the code point into it). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md);
for coding agents: [AGENTS.md](AGENTS.md).

### Tests

From the repository root:

| Command | What |
|---|---|
| `pnpm test` | Vitest: unit, behaviour and integration tests against fake addons built from real captured responses |
| `pnpm run api:check` | Fails if `openapi.json` or the generated client is stale |
| `pnpm run docs:check` | Fails if the docs and code disagree: `/v1` routes vs okf:architecture/core-v1-api, Multitap env vars vs okf:architecture/configuration and `README.md`, migrations vs okf:architecture/core-persistence, version vs CHANGELOG (a missing tag only warns), relative markdown links, `okf:` references |
| `pnpm run contract` | Schemathesis against the generated document, in a native WSL copy of the repo |
| `pnpm run api:diff` | oasdiff breaking-change check against the last `v*` release tag (report-only against `main` only without a tag). Fails on a breaking change unless `packages/api/breaking-accepted.txt` accepts it (see [Versioning](#versioning)) |
| `pnpm run api:mock` | Prism mock server from the document |
| `pnpm run build` | Builds every package's `dist/` as it is packed and published |
| `pnpm run pack:check` | Packs the three packages, installs them into a project outside the workspace, imports them with plain `node` and typechecks a strict NodeNext consumer (needs the npm registry) |
| `pnpm run ci` | lint, typecheck, api:check, api:diff (skipped with a warning without oasdiff), docs:check, tests, pack:check, the secrets scan (and the contract run on native Linux; `--contract` forces it, through WSL on Windows) |

Tests never reach the internet or start ffmpeg. Fixtures under
`packages/addon-protocol/test/fixtures/real/` are real responses with every stream URL
and credential redacted, and a fake engine (`test/fakes/engine.ts`) stands in
for stremio-server-go; the tests and the contract run add it as engine `home`.
