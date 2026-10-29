---
type: Decision
title: "Client picks by default; auto-select falls back through candidates"
description: "Starting playback: a picked source has no fallback and fails visibly; auto-select ranks, prepares the first candidate and tries the next on failure, with attempt and time limits, one torrent retry, failure reasons, and binge and last-source bonuses."
tags: [core, auto-select, playback, decision]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:10:23Z" }
code_refs:
  - "packages/core/src/selection/"
  - "packages/core/src/sessions/"
status: stable
---

Source of truth for starting playback and auto-select 

### 6.3 Starting playback, and auto-select (optional)

**Standard: the client picks.** `POST /v1/sessions` with `source: {key}` plays
that candidate, as a Stremio user picking from the list would:

1. **Pick an engine.** The candidate's `requiresEngine`, else the client's
   `engine`, else the default (today always `home`).
2. **Ask the engine module to prepare it** ([[architecture/engine-prepare-stream]]), passing the **raw `Stream`
   untouched**. While it's running, emit `session.status` with `progress`.
3. **Playable** → store the engine handle, set `status: 'ready'`, emit
   `session.ready`.
4. **Unplayable** → `status: 'failed'`, emit `session.failed`. There's no
   fallback; the client offers the list again, like Stremio does when a stream
   won't play.

**Feature: auto-select.** `source: {auto: true}` lets core choose, for clients
that want one-click play, scheduled preparation without a pick, or recovery
without a person:

1. **Pick an engine.** Later, with several engines: required by affinity,
   otherwise the online engine whose capabilities fit the item best, then least
   loaded. Today it's `home`.
2. **Rank** the list for that engine ([[concept/source-ranking]]) and store the playable candidates
   as `candidates`, in order.
3. **Prepare the first one** as above.
4. **Unplayable** → mark it failed and try the next one. Stop after N (e.g. 5)
   failures and emit `session.failed`. A failed torrent may be retried once,
   after the 30 s negative-probe window, if everything after it also fails.

Neither path learns *why* a source failed beyond a coarse reason. That's the
engine module's business.

**As built in phase 2:**
- Both paths run in the background after `POST /v1/sessions` has answered
  ([[architecture/playback-session]]). Each attempt emits `session.status` with the candidate (`chosen`) and
  the engine's `progress` phases (`metadata`, `probing`).
- Auto-select uses the request's `engine` or the default
  (`MULTITAP_SELECTION_DEFAULT_ENGINE`); there's only one engine to choose from. It skips
  candidates that only play when prepared (`playableWhen: 'prepared'`, phase 4)
  and flagged ones (`flags`, [[concept/source-ranking]]), which it doesn't store as `candidates`.
- N is `MULTITAP_AUTO_SELECT_MAX_ATTEMPTS` (default 5) and counts the retry. Only a torrent
  whose failure the engine module marks retryable (no metadata yet, a failed
  probe, an engine error) is retried, once, `MULTITAP_AUTO_SELECT_RETRY_AFTER_MS` after it
  failed. An `engine-offline` failure ends auto-select at once, since every
  other candidate would fail the same way.
- **Each attempt has a time limit**, `MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS` (default
  45 s; `0` turns it off). Found on the reference engine: a dead torrent costs the
  engine's whole metadata wait (`STREMIO_CREATE_METADATA_TIMEOUT`, 2 min) per
  candidate. Past the limit core aborts that candidate's prepare (the torrent
  create, probe or master request in flight), counts it as a retryable failure
  (so a slow torrent still gets its one retry) and tries the next. A prepare
  that finishes anyway has its engine session released. 45 s leaves a healthy
  torrent time for metadata and probe; an HTTP source normally needs a second
  or two, so the limit doesn't touch it. A picked source has no fallback, so it
  keeps the engine's full timeouts.
- `failureReason` is the engine module's reason ([[architecture/engine-prepare-stream]]) for a picked source; for
  auto-select it's `no-candidates`, `only-flagged` (every playable candidate
  is flagged), `attempts-exhausted`, `candidates-exhausted` or `engine-offline`, and `session.failed` carries the
  number of attempts.
- **Auto-next keeps the release** (stremio-core's `is_binge_match`), stateless:
  a ready session exposes its source's `bingeGroup`, and the client passes it
  back as `source: {auto: true, preferBingeGroup}` for the next episode.
  Candidates with that group get `binge.matchBonus` ([[concept/source-ranking]]), so the best of them
  goes first; the bonus never makes an unplayable candidate playable, and with
  no match the normal ranking applies. `preferBingeGroup` and the request's own
  `preferredLanguage` are part of an auto-select session's identity ([[architecture/playback-session]]),
  since they change the pick. When to go to the next episode stays the
  client's call: a watch-party client, for example, reads the
  ended session's `bingeGroup` from core and, after the maintainer's
  `nextVideoNotificationDuration` countdown, starts the next episode with
  `source: {auto: true, preferBingeGroup}` when the maintainer's `bingeWatching`
  is on (Room WebSocket protocol).
- **Resuming the last source:** with `profileId`, auto-select gives the
  profile's last source for the video ([[architecture/library-and-profiles]]) `lastSource.matchBonus`, so
  "resume" from continue watching reopens it when it still plays; it never
  makes an unplayable candidate playable, and a source the addons no longer
  offer just doesn't match. `profileId` is part of an auto-select session's
  identity. A picked source's session for a profile records it the same way.

Related: [[concept/source-ranking]], [[concept/ranking-settings]], [[decision/destructive-items-flagged]], [[architecture/engine-prepare-stream]], [[architecture/playback-session]], [[architecture/last-source-per-item]].
