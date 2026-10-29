import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { ApiKeyRow, ApiKeyScope } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';

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

/** The principal a verified key authenticates as. */
export interface ApiKeyPrincipal {
  id: string;
  scope: ApiKeyScope;
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
  await db
    .updateTable('api_keys')
    .set({ revoked_at: clock() })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute();
  const row = await db.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirst();
  return row && toRecord(row);
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
 * records its use (at most once per {@link LAST_USED_INTERVAL_MS}); otherwise
 * `undefined`.
 */
export async function verifyApiKey(
  db: Db,
  presented: string,
  clock: Clock,
): Promise<ApiKeyPrincipal | undefined> {
  if (!KEY_PATTERN.test(presented)) return undefined;
  const hash = hashApiKey(presented);
  // The lookup is by hash, so its timing reveals nothing about stored keys;
  // the comparison below is constant-time anyway.
  const row = await db
    .selectFrom('api_keys')
    .select(['id', 'key_hash', 'scope', 'last_used', 'revoked_at'])
    .where('key_hash', '=', hash)
    .executeTakeFirst();
  if (!row) return undefined;
  if (!timingSafeEqual(Buffer.from(row.key_hash, 'hex'), Buffer.from(hash, 'hex'))) {
    return undefined;
  }
  if (row.revoked_at !== null) return undefined;

  const now = clock();
  if (row.last_used === null || now - row.last_used >= LAST_USED_INTERVAL_MS) {
    await db.updateTable('api_keys').set({ last_used: now }).where('id', '=', row.id).execute();
  }
  return { id: row.id, scope: row.scope };
}
