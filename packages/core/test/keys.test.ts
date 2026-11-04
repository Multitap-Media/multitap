import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/index.ts';
import {
  KEY_ACTIVE_CACHE_MS,
  LAST_USED_INTERVAL_MS,
  apiKeyActiveCached,
  createApiKey,
  generateApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  scopeAllows,
  verifyApiKey,
} from '../src/auth/keys.ts';
import { manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

/** `db` counting `api_keys` writes and selects, with writes failing while `failWrites` is set. */
function instrumented(db: Db) {
  const counts = { updates: 0, selects: 0 };
  const control = { failWrites: false };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'updateTable') {
        return (table: 'api_keys') => {
          counts.updates++;
          if (control.failWrites) {
            const failing = {
              set: () => failing,
              where: () => failing,
              execute: () => Promise.reject(new Error('database is locked')),
            };
            return failing;
          }
          return target.updateTable(table);
        };
      }
      if (prop === 'selectFrom') {
        return (table: 'api_keys') => {
          counts.selects++;
          return target.selectFrom(table);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { db: proxy, counts, control };
}

describe('API keys', () => {
  it('are 32 random bytes in base64url', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
    expect(generateApiKey()).not.toBe(key);
  });

  it('are stored only as SHA-256 hex', async () => {
    const db = await migratedMemoryDb();
    const created = await createApiKey(db, { scope: 'client', label: 'party' }, manualClock());
    const rows = await db.selectFrom('api_keys').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_hash).toBe(createHash('sha256').update(created.key).digest('hex'));
    expect(hashApiKey(created.key)).toBe(rows[0]?.key_hash);
    expect(JSON.stringify(rows)).not.toContain(created.key);
  });

  it('verify to their principal; unknown, malformed and revoked keys do not', async () => {
    const db = await migratedMemoryDb();
    const clock = manualClock();
    const admin = await createApiKey(db, { scope: 'admin', label: 'bootstrap' }, clock);
    const client = await createApiKey(db, { scope: 'client', label: 'party' }, clock);

    expect(await verifyApiKey(db, admin.key, clock)).toEqual({
      id: admin.id,
      scope: 'admin',
      label: 'bootstrap',
      createdAt: admin.createdAt,
      lastUsed: clock(),
    });
    expect(await verifyApiKey(db, client.key, clock)).toMatchObject({
      id: client.id,
      scope: 'client',
      label: 'party',
    });
    expect(await verifyApiKey(db, generateApiKey(), clock)).toBeUndefined();
    expect(await verifyApiKey(db, '', clock)).toBeUndefined();
    expect(await verifyApiKey(db, `${client.key}x`, clock)).toBeUndefined();
    expect(await verifyApiKey(db, hashApiKey(client.key), clock)).toBeUndefined();

    clock.advance(1000);
    const revoked = await revokeApiKey(db, client.id, clock);
    expect(revoked?.revokedAt).toBe(clock());
    expect(await verifyApiKey(db, client.key, clock)).toBeUndefined();
  });

  it('revoke is idempotent and returns undefined for unknown ids', async () => {
    const db = await migratedMemoryDb();
    const clock = manualClock();
    const key = await createApiKey(db, { scope: 'client', label: 'x' }, clock);
    const first = await revokeApiKey(db, key.id, clock);
    clock.advance(5000);
    const second = await revokeApiKey(db, key.id, clock);
    expect(second?.revokedAt).toBe(first?.revokedAt);
    expect(await revokeApiKey(db, 'nope', clock)).toBeUndefined();
  });

  it('list returns every key without hashes', async () => {
    const db = await migratedMemoryDb();
    const clock = manualClock();
    const a = await createApiKey(db, { scope: 'admin', label: 'a' }, clock);
    clock.advance(1);
    const b = await createApiKey(db, { scope: 'client', label: 'b' }, clock);
    await revokeApiKey(db, b.id, clock);
    const list = await listApiKeys(db);
    expect(list.map((k) => [k.id, k.scope, k.label, k.revokedAt !== null])).toEqual([
      [a.id, 'admin', 'a', false],
      [b.id, 'client', 'b', true],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('update last_used at most once a minute', async () => {
    const db = await migratedMemoryDb();
    const clock = manualClock();
    const key = await createApiKey(db, { scope: 'client', label: 'x' }, clock);
    const lastUsed = async () =>
      (await db.selectFrom('api_keys').select('last_used').executeTakeFirstOrThrow()).last_used;

    expect(await lastUsed()).toBeNull();
    const t0 = clock();
    expect((await verifyApiKey(db, key.key, clock))?.lastUsed).toBe(t0);
    await vi.waitFor(async () => {
      expect(await lastUsed()).toBe(t0);
    });

    clock.advance(LAST_USED_INTERVAL_MS - 1);
    expect((await verifyApiKey(db, key.key, clock))?.lastUsed).toBe(t0);
    expect(await lastUsed()).toBe(t0);

    clock.advance(1);
    await verifyApiKey(db, key.key, clock);
    await vi.waitFor(async () => {
      expect(await lastUsed()).toBe(t0 + LAST_USED_INTERVAL_MS);
    });
  });

  it('write last_used once for concurrent requests, without waiting for it', async () => {
    const base = await migratedMemoryDb();
    const clock = manualClock();
    const key = await createApiKey(base, { scope: 'client', label: 'x' }, clock);
    const { db, counts } = instrumented(base);
    const principals = await Promise.all(
      Array.from({ length: 5 }, () => verifyApiKey(db, key.key, clock)),
    );
    expect(principals.map((p) => p?.lastUsed)).toEqual(Array(5).fill(clock()));
    expect(counts.updates).toBe(1);
    // Within the minute nothing more is written, though the row may not show it yet.
    clock.advance(1_000);
    await verifyApiKey(db, key.key, clock);
    expect(counts.updates).toBe(1);
  });

  it('authenticate when the last_used write fails, log it, and retry it next time', async () => {
    const base = await migratedMemoryDb();
    const clock = manualClock();
    const log = memoryLogger();
    const key = await createApiKey(base, { scope: 'client', label: 'x' }, clock);
    const { db, counts, control } = instrumented(base);
    control.failWrites = true;
    expect(await verifyApiKey(db, key.key, clock, log.logger)).toMatchObject({ id: key.id });
    await vi.waitFor(() => {
      expect(log.lines()).toContainEqual(
        expect.objectContaining({ apiKeyId: key.id, msg: 'api key: storing last_used failed' }),
      );
    });
    control.failWrites = false;
    await verifyApiKey(db, key.key, clock, log.logger);
    expect(counts.updates).toBe(2);
  });

  it('answer activity from memory for a second, and see a revocation at once', async () => {
    const base = await migratedMemoryDb();
    const clock = manualClock();
    const key = await createApiKey(base, { scope: 'client', label: 'x' }, clock);
    const { db, counts } = instrumented(base);
    const checks = await Promise.all([1, 2, 3].map(() => apiKeyActiveCached(db, key.id, clock)));
    expect(checks).toEqual([true, true, true]);
    expect(counts.selects).toBe(1);
    clock.advance(KEY_ACTIVE_CACHE_MS - 1);
    expect(await apiKeyActiveCached(db, key.id, clock)).toBe(true);
    expect(counts.selects).toBe(1);
    // Revoked in another process: seen once the answer is a second old.
    await base.updateTable('api_keys').set({ revoked_at: clock() }).execute();
    clock.advance(1);
    expect(await apiKeyActiveCached(db, key.id, clock)).toBe(false);
    expect(counts.selects).toBe(2);
    // Revoked in this process: seen at once.
    const other = await createApiKey(base, { scope: 'client', label: 'y' }, clock);
    expect(await apiKeyActiveCached(db, other.id, clock)).toBe(true);
    await revokeApiKey(db, other.id, clock);
    expect(await apiKeyActiveCached(db, other.id, clock)).toBe(false);
  });

  it.each([
    ['admin', 'admin', true],
    ['admin', 'client', true],
    ['admin', 'metrics', true],
    ['client', 'client', true],
    ['client', 'admin', false],
    ['client', 'metrics', false],
    ['metrics', 'metrics', true],
    ['metrics', 'client', false],
    ['metrics', 'admin', false],
  ] as const)('scope %s allows %s: %s', (granted, required, allowed) => {
    expect(scopeAllows(granted, required)).toBe(allowed);
  });
});
