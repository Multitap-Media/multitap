---
type: Finding
title: "Review finding: a migration cut short leaves the database half-migrated and core unable to start"
description: "migrateToLatest runs Kysely's Migrator, which on SQLite runs each migration's statements without a transaction and records the migration only at the end; a full disk, crash or kill during a multi-statement migration leaves its first tables in place, unrecorded, and every later start fails with \"table already exists\" until someone repairs the database by hand."
tags: [core, review, bugs-library, persistence, migrations, finding]
generated: { by: agent/mcp, at: "2026-10-20T13:13:12Z" }
code_refs:
  - "packages/core/src/db/index.ts"
  - "packages/core/migrations/"
status: draft
---

Area `bugs-library` of the [core adversarial review](charter.md); listed in [bugs-library progress](bugs-library-progress.md).

- **Severity:** medium. **Kind:** bug.
- **Verdict:** confirmed.
- **Status:** fixed 2026-10-20 (see [Fix](#fix)).
- **Where:** `packages/core/src/db/index.ts:53-75` (`migrateToLatest`: a plain `Migrator` with no transaction around each `up`), `packages/core/migrations/0003_sessions_library_settings.ts` (several CREATEs), likewise 0005 (table rebuild), 0007 and 0009 (several ALTERs each); `packages/core/src/cli.ts:234` and `packages/core/src/index.ts:64` both migrate.

## What happens

Kysely's SQLite adapter doesn't report transactional DDL, so its `Migrator` runs each migration's statements one by one and inserts the `kysely_migration` row only after `up` returns. If the process dies or a statement fails part-way (disk full, container killed during an upgrade, power loss), the statements already run stay and the migration is not recorded. On the next start the migration runs again from the top and fails on its first `CREATE TABLE` ("table playback_sessions already exists"), so core never starts again; the operator has to drop the half-made tables or record the migration by hand in SQL. No user data is lost, but this happens exactly when an operator upgrades.

A smaller variant: core and the CLI migrating the same file at once race (Kysely's SQLite migration lock is a no-op); one of them fails part-way. In practice that is the CLI command erroring (low).

## Evidence

The PoC, now a normal test in `packages/core/test/migrations.test.ts` (it was `it.fails` in `packages/core/test/review-poc/bugs-library/persistence-migrations.test.ts`): "a migration cut short by a full disk leaves no trace of itself" and "once the disk has room again, the next start completes the migrations" (the full disk simulated with `PRAGMA max_page_count`), and "two connections migrating the same file at once both succeed".

```bash
pnpm vitest run packages/core/test/migrations.test.ts
```

## Fix direction

Run each migration's `up` and its bookkeeping row inside one transaction (SQLite supports transactional DDL), e.g. a custom migration runner or `BEGIN IMMEDIATE` around the migrator, which also serialises core and the CLI.

## Fix

`migrateToLatest` hands Kysely's migrator a transaction it opens itself with `BEGIN IMMEDIATE`, through a second Kysely over the same connection whose adapter reports transactional DDL. All pending migrations and their `kysely_migration` rows commit together or roll back together, and a second runner (the CLI, or core) waits for the lock with an async retry and then finds nothing pending. The design is in [core persistence](../architecture/core-persistence.md).

## Public-release blocker

Yes, arguably: public operators upgrade unattended, and a failed upgrade must not need manual SQL to recover.
