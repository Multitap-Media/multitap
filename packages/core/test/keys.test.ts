import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LAST_USED_INTERVAL_MS,
  createApiKey,
  generateApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  scopeAllows,
  verifyApiKey,
} from '../src/auth/keys.ts';
import { manualClock, migratedMemoryDb } from './helpers.ts';

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

    expect(await verifyApiKey(db, admin.key, clock)).toEqual({ id: admin.id, scope: 'admin' });
    expect(await verifyApiKey(db, client.key, clock)).toEqual({ id: client.id, scope: 'client' });
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
    await verifyApiKey(db, key.key, clock);
    expect(await lastUsed()).toBe(t0);

    clock.advance(LAST_USED_INTERVAL_MS - 1);
    await verifyApiKey(db, key.key, clock);
    expect(await lastUsed()).toBe(t0);

    clock.advance(1);
    await verifyApiKey(db, key.key, clock);
    expect(await lastUsed()).toBe(t0 + LAST_USED_INTERVAL_MS);
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
