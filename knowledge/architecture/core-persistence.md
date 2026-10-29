---
type: Architecture
title: "Core persistence: tables, migrations 0001 to 0011, backups and restart"
description: "Core's SQLite tables (addons, engines, api_keys, profiles, last_sources, item_player_states, library_items, playback_sessions, engine_sessions, session_subtitle_offsets, prepare_jobs, token_revocations, settings), the full migrations list, online backups and restore, and restart behaviour."
tags: [persistence, sqlite, migrations, backup, core, architecture]
generated: { by: "agent/claude-sonnet-5.5", at: "2026-10-17T02:19:10Z" }
code_refs:
  - "packages/core/migrations/"
  - "packages/core/src/"
status: stable
---

Source of truth for this topic ((docs:check reads the migrations list from this concept)).

| Table | Contents |
|---|---|
| `addons` | id, manifest_url (secret), enabled, position, manifest_json (cached), manifest_fetched_at, created_at |
| `engines` | id, name, transport, address (later: pairing), capabilities_json, local_addon, last_seen, proxy_password (secret) |
| `api_keys` | id, key_hash, scope (`client`/`admin`/`metrics`), label, created_at, last_used, revoked_at |
| `profiles` | id, name, created_at, settings_json (the settings a client set, sparse; [[architecture/library-and-profiles]]) |
| `last_sources` | profile_id + item_id (key; deleted with the profile), video_id, source_identity (the candidate key, a hash), addon_id, addon_name, name, title, binge_group, played_at ([[architecture/library-and-profiles]]) |
| `item_player_states` | profile_id + item_id (key; deleted with the profile), audio_language, subtitle_json (`ItemSubtitleChoice`), subtitle_offset_ms, playback_speed, updated_at: the per-item player state (stremio-core's `StreamItemState`, [[architecture/core-v1-api]]) |
| `library_items` | profile_id + item_id (key), type, name, poster, poster_shape, removed, temp, state_json and behavior_hints_json (stremio-core's `LibraryItem` field names, [[architecture/library-and-profiles]]), ctime, mtime |
| `playback_sessions` | id, key, item_type, item_id, video_id, source_json, identity (idempotency hash, [[architecture/playback-session]]), candidates_json, chosen_key, stream_json (the raw Stream; secret), engine_id, sid, delivery, mode, high_res, requested_quality_json, quality_json (applied), ready_by, retain_until, status, failure_reason, token_epoch, created_at, updated_at, last_access, released_at, tracks_json, audio_track, binge_group, profile_id |
| `engine_sessions` | engine_id + sid (key), session_key, stream_hash, quality_key (unique together with engine_id, session_key and stream_hash), applied_quality_json, media_url (secret), created_at, last_used, release_pending_since, release_attempts, release_next_at (a pending release, [[architecture/engine-retention]]) |
| `session_subtitle_offsets` | session_id (deleted with its session) + file_id (key), offset_ms: a session-wide subtitle timing offset, only rows that are not 0 ([[architecture/core-v1-api]]) |
| `prepare_jobs` | phase 4, not created yet: sid, total_segments, done_segments, state, start_at, ready_by |
| `token_revocations` | session_id (deleted with its session), subject, until |
| `settings` | key, value_json, updated_at: operator overrides of built-in defaults (key `ranking`, [[concept/source-ranking]]) |

Tables are SQLite `STRICT`, timestamps are Unix milliseconds, and migrations
are Kysely files in `packages/core/migrations/`: `0001_initial` (addons, engines,
API keys), `0002_engine_local_addon`, `0003_sessions_library_settings` (the
phase 2 tables), `0004_home_engine_phase0` (updates the `home` seed to phase 0's
capabilities only where it still holds the old seed, and adds
`sessionOverrides: false` to any other engine without it; core no longer seeds `home`, so on a fresh database it finds nothing to update) and
`0005_api_key_metrics_scope` (rebuilds `api_keys` to allow the `metrics`
scope), `0006_engine_proxy_password` ([[architecture/secrets-policy]]) and
`0007_engine_session_release_retry` (pending releases, [[architecture/engine-retention]]),
`0008_session_tracks_binge`, `0009_profile_settings_last_source` ([[architecture/library-and-profiles]], [[architecture/library-and-profiles]])
and `0010_session_subtitle_offsets` ([[architecture/core-v1-api]]), and `0011_item_player_states`
(the per-item player state, [[architecture/core-v1-api]]). The secret columns are listed once in code (`SECRET_COLUMNS`), and a
test keeps them out of every API view.

**How migrations run** (`migrateToLatest`, `packages/core/src/db/index.ts`), at
core's start and in the CLI, which may be the first to open the database after
an upgrade:

- **Atomically.** Kysely's SQLite adapter would run each migration outside a
  transaction and record it only afterwards, so a crash or full disk part-way
  left a half-applied migration that failed on every later start. Core hands
  the migrator a transaction instead: all pending migrations and their
  `kysely_migration` rows commit together or not at all (SQLite has
  transactional DDL).
- **One runner at a time.** The transaction starts with `BEGIN IMMEDIATE`, so
  core and the CLI migrating the same file take turns; the second waits (an
  async retry, up to 60 s) and then finds nothing pending.
- **Foreign keys off.** A table rebuild (create `_new`, copy, drop, rename;
  SQLite's way to change a `CHECK`, a column type or `STRICT`, as 0005 does)
  cascade-deletes every child row while foreign keys are on, and the pragma
  can't change inside a transaction. So foreign keys are off for the run, and
  `PRAGMA foreign_key_check` runs after each migration: a migration that leaves
  a broken reference fails and the run rolls back. Migrations are written
  without touching the pragma themselves.
- **Backed up first.** When an existing database has pending migrations, a
  verified online backup (the same copy and checks as below) is written to
  `<MULTITAP_BACKUP_DIR>/pre-migration/multitap-<timestamp>-before-<first pending>.sqlite`
  before any runs. The newest 3 are kept, apart from the `/v1/admin/backups`
  list and `MULTITAP_BACKUP_KEEP`. A fresh database gets none. If the backup fails, the
  upgrade doesn't start, and the error names the folder to check.

**Backups.** A live WAL-mode database must not be copied as a file. Core backs
it up through the admin API (`/v1/admin/backups`, [[architecture/core-v1-api]]) with SQLite's online
backup (better-sqlite3's `backup()`): a consistent snapshot, copied in steps
while core keeps serving. The copy is switched to a single self-contained file
(no `-wal`/`-shm`), reopened read-only and checked with `PRAGMA integrity_check`;
only then is it kept and the oldest backups beyond `MULTITAP_BACKUP_KEEP` pruned. A
failed backup logs a warning, counts as a failure in `multitap_backup_outcomes_total` and
leaves the older backups alone; one backup runs at a time (a second request gets
`409`). Files are `multitap-<UTC timestamp>.sqlite` in `MULTITAP_BACKUP_DIR` (default
`<MULTITAP_DATA_DIR>/backups`), or `multitap-<timestamp>-scheduled.sqlite` when the timer
made them (`MULTITAP_BACKUP_INTERVAL_MS`, off by default; the timer runs from core's
start to its stop). The id is the file name without `.sqlite` and is validated
against a strict pattern, so it can't name a path outside the directory. **A
backup holds every secret the database does** (engine proxy passwords, stored
raw streams, hashed API keys): it is written with mode `0600` in a `0700`
directory where the platform has modes, and the download is as sensitive as the
database. Logs name only the id and size. Restore: stop core, replace
`multitap.sqlite` with the backup, delete any stale `multitap.sqlite-wal` and
`multitap.sqlite-shm`, start core; pending migrations run at startup. To undo an
upgrade, restore the newest pre-migration backup the same way and run the
previous image: a downgrade on the migrated file fails loudly, since Kysely
refuses a database with migrations it doesn't know. Metrics:
`multitap_backup_last_success_timestamp_seconds` and `multitap_backup_outcomes_total{kind,outcome}`.
Backups on the same disk don't survive losing it: copy them off the machine.

A core restart keeps every playback session. The first master request
self-heals the engine session if needed, and clients re-read session state
when their event stream reconnects. Sessions that were still resolving fail
with `interrupted` ([[architecture/playback-session]]).

Related: [[architecture/library-and-profiles]], [[architecture/secrets-policy]], [[architecture/playback-session]], [[architecture/core-v1-api]].
