/**
 * Multitap adversarial review, area sec-access (knowledge/core-review/sec-access-progress.md).
 * Passing tests record properties that hold; `it.fails` tests demonstrate a bug
 * (they pass while the bug exists).
 */
import { openApiDocument } from '../../../src/http/app.ts';
import { describe, expect, it } from 'vitest';
import { bearer, testApp } from '../../helpers.ts';

/** Every documented operation as a concrete path (parameters filled with dummies). */
function documentedOperations(): { method: string; path: string }[] {
  const doc = openApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> };
  const out: { method: string; path: string }[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of Object.keys(ops)) {
      out.push({ method: method.toUpperCase(), path: path.replace(/\{[^}]+\}/g, 'x') });
    }
  }
  return out;
}

describe('scope enforcement (holds)', () => {
  it('a client key gets 403 on every /v1/admin operation and on /metrics', async () => {
    const { app, keyFor } = await testApp();
    const client = bearer(await keyFor('client'));
    const admin = documentedOperations().filter(
      (op) => op.path.startsWith('/v1/admin') || op.path === '/metrics',
    );
    expect(admin.length).toBeGreaterThan(20);
    for (const op of admin) {
      const res = await app.request(op.path, {
        method: op.method,
        headers: { ...client, 'Content-Type': 'application/json' },
        body: op.method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${op.method} ${op.path}`).toBe(403);
    }
  });

  it('a metrics key gets 403 on every /v1 operation and the OpenAPI document', async () => {
    const { app, keyFor } = await testApp();
    const metrics = bearer(await keyFor('metrics'));
    const ops = documentedOperations().filter(
      (op) => op.path !== '/metrics' && op.path !== '/healthz',
    );
    for (const op of ops) {
      const res = await app.request(op.path, {
        method: op.method,
        headers: { ...metrics, 'Content-Type': 'application/json' },
        body: op.method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${op.method} ${op.path}`).toBe(403);
    }
    expect((await app.request('/metrics', { headers: metrics })).status).toBe(200);
  });

  it('no key: every documented operation but /healthz answers the unknown-route 404', async () => {
    const { app } = await testApp();
    for (const op of documentedOperations().filter((o) => o.path !== '/healthz')) {
      const res = await app.request(op.path, { method: op.method });
      expect(res.status, `${op.method} ${op.path}`).toBe(404);
    }
  });

  it('path tricks do not let a client key past the /v1/admin middleware', async () => {
    const { app, keyFor } = await testApp();
    const client = bearer(await keyFor('client'));
    for (const path of [
      '/v1//admin/api-keys',
      '/v1/admin//api-keys',
      '//v1/admin/api-keys',
      '/v1/%61dmin/api-keys',
      '/v1/admin%2fapi-keys',
      '/v1/admin/api-keys/',
      '/V1/admin/api-keys',
      '/v1/ADMIN/api-keys',
      '/v1/./admin/api-keys',
      '/v1/x/../admin/api-keys',
      '/v1/admin/api-keys;x',
      '/v1/admin/api-keys%00',
    ]) {
      const res = await app.request(`http://core.test${path}`, { headers: client });
      expect([403, 404], path).toContain(res.status);
    }
  });
});
