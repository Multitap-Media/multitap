import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { ApiKeyRow, ApiKeyScope } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../log.ts';

export type { ApiKeyScope } from '../db/schema.ts';
export type { Clock } from '../lib/clock.ts';

export const API_KEY_SCOPES = [
  'client',
  'admin',
  'metrics',
] as const satisfies readonly ApiKeyScope[];

/** `last_used` is written at most this often per key (okf:architecture/core-api-keys-security). */
export const LAST_USED_INTERVAL_MS = 60_000;

/** An API key as stored, without its hash. */
export interface ApiKeyRecord {
  id: string;
  scope: ApiKeyScope;
  label: string;
  createdAt: number;
  lastUsed: number | null;
  revokedAt: number | null;
}

/** The principal a verified key authenticates as: the key as read when it was verified. */
export interface ApiKeyPrincipal {
  id: string;
  scope: ApiKeyScope;
  label: string;
  createdAt: number;
  /** The key's last use, this request's when it was the one recorded. */
  lastUsed: number | null;
}

// 32 random bytes in base64url without padding is always 43 characters.
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new key: 32 random bytes, base64url. */
export function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of the key as lowercase hex, the only form that is stored. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** `admin` implies `client` and `metrics`. */
export function scopeAllows(granted: ApiKeyScope, required: ApiKeyScope): boolean {
  return granted === 'admin' || granted === required;
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    revokedAt: row.revoked_at,
  };
}

/** Creates a key. The returned `key` is the only time it is available. */
export async function createApiKey(
  db: Db,
  input: { scope: ApiKeyScope; label: string },
  clock: Clock,
): Promise<ApiKeyRecord & { key: string }> {
  const key = generateApiKey();
  const row: ApiKeyRow = {
    id: randomUUID(),
    key_hash: hashApiKey(key),
    scope: input.scope,
    label: input.label,
    created_at: clock(),
    last_used: null,
    revoked_at: null,
  };
  await db.insertInto('api_keys').values(row).execute();
  return { ...toRecord(row), key };
}

/** Every key, oldest first, including revoked ones. */
export async function listApiKeys(db: Db): Promise<ApiKeyRecord[]> {
  const rows = await db
    .selectFrom('api_keys')
    .selectAll()
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toRecord);
}

/** One key by id, or `undefined`. */
export async function getApiKey(db: Db, id: string): Promise<ApiKeyRecord | undefined> {
  const row = await db.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirst();
  return row && toRecord(row);
}

/**
 * Revokes a key. Revoking an already revoked key keeps its original
 * `revokedAt`. Returns `undefined` for an unknown id.
 */
export async function revokeApiKey(
  db: Db,
  id: string,
  clock: Clock,
): Promise<ApiKeyRecord | undefined> {
  activity(db).delete(id);
  await db
    .updateTable('api_keys')
    .set({ revoked_at: clock() })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute();
  const row = await db.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirst();
  activity(db).set(id, { active: row?.revoked_at === null, checkedAt: clock() });
  return row && toRecord(row);
}

/** Entries kept per database in the in-memory key caches below; cleared wholesale past it. */
const KEY_CACHE_MAX_ENTRIES = 10_000;

/** How long {@link apiKeyActiveCached} trusts its last answer for a key. */
export const KEY_ACTIVE_CACHE_MS = 1_000;

interface Activity {
  active: boolean;
  checkedAt: number;
  pending?: Promise<boolean>;
}

/** Per database: key id → its last activity check (and the one in flight). */
const activityByDb = new WeakMap<Db, Map<string, Activity>>();

function activity(db: Db): Map<string, Activity> {
  let map = activityByDb.get(db);
  if (map === undefined) {
    map = new Map();
    activityByDb.set(db, map);
  }
  return map;
}

/**
 * {@link apiKeyActive}, answered from memory when checked less than
 * {@link KEY_ACTIVE_CACHE_MS} ago, with one query in flight per key, shared by
 * every open `/v1/events` stream of that key (okf:architecture/core-events-sse).
 * A revocation through {@link revokeApiKey} in this process is seen at once;
 * one made by another process (the CLI) within about a second.
 */
export async function apiKeyActiveCached(db: Db, id: string, clock: Clock): Promise<boolean> {
  const known = activity(db);
  const entry = known.get(id);
  if (entry?.pending !== undefined) return entry.pending;
  if (entry !== undefined && clock() - entry.checkedAt < KEY_ACTIVE_CACHE_MS) return entry.active;
  if (known.size >= KEY_CACHE_MAX_ENTRIES) known.clear();
  const checking: Activity = { active: entry?.active ?? false, checkedAt: entry?.checkedAt ?? 0 };
  checking.pending = apiKeyActive(db, id).then(
    (active) => {
      // A revocation in this process meanwhile replaced the entry: it wins.
      if (known.get(id) === checking) known.set(id, { active, checkedAt: clock() });
      return known.get(id)?.active ?? active;
    },
    (err: unknown) => {
      if (known.get(id) === checking) known.delete(id);
      throw err;
    },
  );
  known.set(id, checking);
  return checking.pending;
}

/** Per database: key id → the last `last_used` this process wrote (or is writing). */
const lastUsedByDb = new WeakMap<Db, Map<string, number>>();

function lastUsedWrites(db: Db): Map<string, number> {
  let map = lastUsedByDb.get(db);
  if (map === undefined) {
    map = new Map();
    lastUsedByDb.set(db, map);
  }
  return map;
}

/**
 * Whether the key with this id exists and isn't revoked. Open `/v1/events`
 * streams re-check their key with it, since a revocation may come from the
 * CLI in another process (okf:architecture/core-events-sse).
 */
export async function apiKeyActive(db: Db, id: string): Promise<boolean> {
  const row = await db
    .selectFrom('api_keys')
    .select('revoked_at')
    .where('id', '=', id)
    .executeTakeFirst();
  // A missing row gives undefined, which isn't null.
  return row?.revoked_at === null;
}

/**
 * Checks a presented key. Returns the principal for a known, unrevoked key and
 * records its use (at most once per {@link LAST_USED_INTERVAL_MS} per key,
 * concurrent requests included); otherwise `undefined`.
 *
 * The `last_used` write is not awaited: a busy database must not fail the
 * request it authenticates. A failed write is logged (`warn`) and retried by
 * the key's next request.
 */
export async function verifyApiKey(
  db: Db,
  presented: string,
  clock: Clock,
  logger?: Pick<Logger, 'warn'>,
): Promise<ApiKeyPrincipal | undefined> {
  if (!KEY_PATTERN.test(presented)) return undefined;
  const hash = hashApiKey(presented);
  // The lookup is by hash, so its timing reveals nothing about stored keys;
  // the comparison below is constant-time anyway.
  const row = await db
    .selectFrom('api_keys')
    .select(['id', 'key_hash', 'scope', 'label', 'created_at', 'last_used', 'revoked_at'])
    .where('key_hash', '=', hash)
    .executeTakeFirst();
  if (!row) return undefined;
  if (!timingSafeEqual(Buffer.from(row.key_hash, 'hex'), Buffer.from(hash, 'hex'))) {
    return undefined;
  }
  if (row.revoked_at !== null) return undefined;

  const now = clock();
  const written = lastUsedWrites(db);
  const recorded = written.get(row.id);
  let lastUsed =
    recorded === undefined || (row.last_used !== null && row.last_used > recorded)
      ? row.last_used
      : recorded;
  if (lastUsed === null || now - lastUsed >= LAST_USED_INTERVAL_MS) {
    if (written.size >= KEY_CACHE_MAX_ENTRIES) written.clear();
    written.set(row.id, now);
    lastUsed = now;
    void db
      .updateTable('api_keys')
      .set({ last_used: now })
      .where('id', '=', row.id)
      .execute()
      .catch((err: unknown) => {
        // Let the key's next request try again.
        if (written.get(row.id) === now) written.delete(row.id);
        logger?.warn({ err, apiKeyId: row.id }, 'api key: storing last_used failed');
      });
  }
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    createdAt: row.created_at,
    lastUsed,
  };
}
