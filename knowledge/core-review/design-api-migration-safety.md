---
type: Finding
title: "Finding: upgrades migrate in place with foreign keys on and no backup, so a routine table rebuild would erase libraries"
description: "Migrations run on the live database with `foreign_keys = ON`; rebuilding a parent table the way migration 0005 did cascade-deletes every child row (PoC: a profiles rebuild empties library_items), and core takes no backup before applying migrations (scheduled backups are off by default)."
tags: [core, review, design, design-api, persistence, migrations]
generated: { by: agent/mcp, at: "2026-10-20T11:55:10Z" }
code_refs:
  - "packages/core/src/db/index.ts"
  - "packages/core/migrations/"
  - "packages/core/src/config.ts"
status: draft
---

Area: [design-api](design-api-progress.md) of the [core adversarial review](charter.md).

- **Severity:** medium. **Kind:** design-flaw (latent data loss on upgrade).
- **Verdict:** confirmed (PoC test). No shipped migration triggers it yet.
- **Status:** fixed 2026-10-20 (see [Fix](#fix)).

## Where

- `packages/core/src/db/index.ts:33`: `openDatabase` turns `foreign_keys = ON` for every connection, including the one `migrateToLatest` (`:53`) runs on, at startup (`packages/core/src/index.ts:64`) and in the CLI (`packages/core/src/cli.ts:234`).
- `packages/core/migrations/0005_api_key_metrics_scope.ts`: the project's established pattern for a change SQLite can't `ALTER` (a `CHECK`, a column type, `STRICT`): create `_new`, copy, `DROP TABLE` the old one, rename.
- `packages/core/migrations/0003_sessions_library_settings.ts:94,115` and later migrations: `library_items`, `last_sources`, `item_player_states`, `token_revocations`, `session_subtitle_offsets` reference `profiles` or `playback_sessions` with `ON DELETE CASCADE`.
- `packages/core/src/config.ts:415`: `BACKUP_INTERVAL_MS` defaults to `0` (no scheduled backups); nothing backs up before migrating.

## What happens

`DROP TABLE` on a parent performs an implicit `DELETE` that fires `ON DELETE CASCADE` while foreign keys are on. So the first migration that rebuilds `profiles` or `playback_sessions` with the 0005 pattern deletes every library item, last source and player state on every install that upgrades, silently, and the migration reports success. The `PRAGMA foreign_keys` switch is a no-op inside a transaction, so the migration author can't easily turn it off from inside a migration either; the safe recipe (SQLite's "12-step" ALTER: foreign keys off outside the transaction, rebuild, `foreign_key_check`, foreign keys on) has to be built into the runner.

Combined with no automatic pre-migration backup and backups off by default, a public user upgrading the image has no copy to go back to. (Related, separate: migrations are not atomic on SQLite, see the bugs-library area's `persistence-migrations` PoC; a downgrade fails loudly because Kysely refuses a database with unknown migrations, which is good.)

## Evidence

The PoC, now a normal test in `packages/core/test/migrations.test.ts` (it was `it.fails` in `packages/core/test/review-poc/design-api/migration-fk-cascade.test.ts`): migrates an in-memory database, inserts a profile and one library item, then runs the real migrations plus a hypothetical `0012_rebuild_profiles` written exactly like 0005.

```
pnpm vitest run packages/core/test/migrations.test.ts
# before the fix:
AssertionError: expected +0 to be 1 // Object.is equality      (library_items after the rebuild)
```

## Fix direction

Run migrations with `PRAGMA foreign_keys = OFF` (set before the migrator starts, not inside a migration), then `PRAGMA foreign_key_check` and fail the upgrade on any violation before turning them back on; and take an online backup (the existing `BackupService`) automatically whenever migrations are pending, kept apart from the rotation.

## Fix

- **Foreign keys off.** `migrateToLatest` turns `foreign_keys` off on the connection before the migration transaction and back on after it, and runs `PRAGMA foreign_key_check` after each migration inside the transaction: a migration that leaves a broken reference fails and the whole run rolls back.
- **Backup first.** When an existing database has pending migrations, core and the CLI write a verified online backup (`backupBeforeMigrating`, built on the `BackupService` copy and checks) to `<BACKUP_DIR>/pre-migration/` before any runs, keeping the newest 3, apart from the API's list and `BACKUP_KEEP`. A failed backup stops the upgrade.

The design is in [core persistence](../architecture/core-persistence.md).

## Public-release blocker

No (nothing triggers it today), but both parts should land before the first public upgrade ships a migration, since that is when outside users' data is at stake.
