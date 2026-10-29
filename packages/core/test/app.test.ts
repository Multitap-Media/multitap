import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { LAST_USED_INTERVAL_MS } from '../src/auth/keys.ts';
import { PROBLEM_CONTENT_TYPE } from '../src/http/problem.ts';
import { bearer, testApp } from './helpers.ts';

async function problemOf(res: Response) {
  expect(res.headers.get('Content-Type')).toBe(PROBLEM_CONTENT_TYPE);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /healthz', () => {
  it('answers without a key when the database is reachable', async () => {
    const { app } = await testApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 problem JSON when the database is gone', async () => {
    const { app, db } = await testApp();
    await db.destroy();
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    expect(await problemOf(res)).toMatchObject({ status: 503, title: 'Service Unavailable' });
  });
});

describe('errors', () => {
  it('are RFC 9457 problem JSON for unknown routes', async () => {
    const { app } = await testApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await problemOf(res)).toEqual({ type: 'about:blank', title: 'Not Found', status: 404 });
  });

  it('are 405 with Allow for a documented path asked with another method', async () => {
    const { app, keyFor } = await testApp();
    const health = await app.request('/healthz', { method: 'DELETE' });
    expect(health.status).toBe(405);
    expect(health.headers.get('Allow')).toBe('GET, HEAD');
    expect(await problemOf(health)).toMatchObject({ status: 405, title: 'Method Not Allowed' });

    const key = bearer(await keyFor('admin'));
    const engine = await app.request('/v1/admin/engines/home', { method: 'POST', headers: key });
    expect(engine.status).toBe(405);
    expect(engine.headers.get('Allow')).toBe('DELETE, GET, HEAD, PUT');
    // A concrete path wins over a templated one, as in OpenAPI.
    const order = await app.request('/v1/admin/addons/order', { method: 'PATCH', headers: key });
    expect(order.status).toBe(405);
    expect(order.headers.get('Allow')).toBe('PUT');
    // Authentication comes first: without a key it's the usual 404.
    const hidden = await app.request('/v1/admin/engines/home', { method: 'POST' });
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('Allow')).toBeNull();
    // Among templated paths, the one with fewer parameters wins.
    const revokeAll = await app.request('/v1/sessions/ps_x/tokens/revoke-all', {
      method: 'DELETE',
      headers: key,
    });
    expect(revokeAll.status).toBe(405);
    expect(revokeAll.headers.get('Allow')).toBe('POST');
  });

  it('are 400 when a required JSON body is missing, even for an all-optional schema', async () => {
    const { app, keyFor } = await testApp();
    const key = bearer(await keyFor('admin'));
    const missing = await app.request('/v1/admin/ranking', { method: 'PATCH', headers: key });
    expect(missing.status).toBe(400);
    expect(await problemOf(missing)).toMatchObject({ status: 400 });
    const text = await app.request('/v1/admin/ranking', {
      method: 'PATCH',
      headers: { ...key, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(text.status).toBe(400);
    const json = await app.request('/v1/admin/ranking', {
      method: 'PATCH',
      headers: { ...key, 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    expect(json.status).toBe(200);
  });

  it('include a request id header, and reuse a sane incoming one', async () => {
    const { app } = await testApp();
    const generated = await app.request('/healthz');
    expect(generated.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await app.request('/nope', { headers: { 'X-Request-Id': 'abc-123' } });
    expect(echoed.headers.get('X-Request-Id')).toBe('abc-123');
  });

  it('validation failures list each issue', async () => {
    const { app, keyFor } = await testApp();
    const res = await app.request('/v1/admin/api-keys', {
      method: 'POST',
      headers: { ...bearer(await keyFor('admin')), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'root', label: '' }),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400 });
    const errors = problem.errors as { in: string; path: string }[];
    expect(errors.map((e) => [e.in, e.path]).sort()).toEqual([
      ['json', 'label'],
      ['json', 'scope'],
    ]);
  });

  it('malformed JSON is a 400 problem, not a 500', async () => {
    const { app, keyFor } = await testApp();
    const res = await app.request('/v1/admin/api-keys', {
      method: 'POST',
      headers: { ...bearer(await keyFor('admin')), 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(await problemOf(res)).toMatchObject({ status: 400 });
  });
});

describe('auth (okf:architecture/core-api-keys-security)', () => {
  const unknownRoute = async (app: Awaited<ReturnType<typeof testApp>>['app']) => {
    const res = await app.request('/v1/definitely-not-a-route');
    return { status: res.status, type: res.headers.get('Content-Type'), body: await res.text() };
  };

  it('a missing, malformed, unknown or revoked key gets the same 404 as an unknown route', async () => {
    const { app, keyFor, db } = await testApp();
    const expected = await unknownRoute(app);
    expect(expected.status).toBe(404);

    const revoked = await keyFor('admin');
    await db.updateTable('api_keys').set({ revoked_at: 1 }).execute();

    const attempts: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer' },
      { Authorization: 'Basic dXNlcjpwYXNz' },
      bearer('not-a-key'),
      bearer('A'.repeat(43)),
      bearer(revoked),
    ];
    for (const headers of attempts) {
      for (const path of ['/v1/admin/api-keys', '/openapi.json']) {
        const res = await app.request(path, { headers });
        expect({
          status: res.status,
          type: res.headers.get('Content-Type'),
          body: await res.text(),
        }).toEqual(expected);
      }
    }
  });

  it('a valid key without the scope gets 403', async () => {
    const { app, keyFor } = await testApp();
    const res = await app.request('/v1/admin/api-keys', {
      headers: bearer(await keyFor('client')),
    });
    expect(res.status).toBe(403);
    expect(await problemOf(res)).toMatchObject({ status: 403, title: 'Forbidden' });
  });

  it('admin implies client; unknown /v1 routes with a valid key are plain 404s', async () => {
    const { app, keyFor } = await testApp();
    const admin = await keyFor('admin');
    expect((await app.request('/openapi.json', { headers: bearer(admin) })).status).toBe(200);
    const client = await keyFor('client');
    expect((await app.request('/openapi.json', { headers: bearer(client) })).status).toBe(200);
    expect((await app.request('/v1/nope', { headers: bearer(client) })).status).toBe(404);
  });

  it('updates last_used at most once a minute across requests', async () => {
    const { app, keyFor, db, clock } = await testApp();
    const key = await keyFor('admin');
    const lastUsed = async () =>
      (await db.selectFrom('api_keys').select('last_used').executeTakeFirstOrThrow()).last_used;
    const t0 = clock();
    await app.request('/v1/admin/api-keys', { headers: bearer(key) });
    clock.advance(30_000);
    await app.request('/v1/admin/api-keys', { headers: bearer(key) });
    expect(await lastUsed()).toBe(t0);
    clock.advance(LAST_USED_INTERVAL_MS);
    await app.request('/v1/admin/api-keys', { headers: bearer(key) });
    expect(await lastUsed()).toBe(t0 + 30_000 + LAST_USED_INTERVAL_MS);
  });
});

describe('/v1/admin/api-keys', () => {
  it('creates a key that is shown once and then authenticates', async () => {
    const { app, keyFor } = await testApp();
    const admin = bearer(await keyFor('admin'));
    const res = await app.request('/v1/admin/api-keys', {
      method: 'POST',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'client', label: '  party  ' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string; label: string };
    expect(created).toMatchObject({
      scope: 'client',
      label: 'party',
      createdAt: '2026-09-27T12:00:00.000Z',
      lastUsed: null,
      revokedAt: null,
    });
    expect(created.key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.request('/v1/admin/api-keys', { headers: admin });
    const body = await list.text();
    expect(body).toContain(created.id);
    expect(body).not.toContain(created.key);
    expect(body).not.toMatch(/[0-9a-f]{64}/);
    expect(body).not.toContain('hash');

    // The new client key works for client routes and is refused admin ones.
    expect((await app.request('/openapi.json', { headers: bearer(created.key) })).status).toBe(200);
    expect((await app.request('/v1/admin/api-keys', { headers: bearer(created.key) })).status).toBe(
      403,
    );
  });

  it('revokes a key, idempotently; unknown ids are 404', async () => {
    const { app, keyFor, db } = await testApp();
    const admin = bearer(await keyFor('admin'));
    const clientKey = await keyFor('client');
    const { id } = await db
      .selectFrom('api_keys')
      .select('id')
      .where('scope', '=', 'client')
      .executeTakeFirstOrThrow();

    const res = await app.request(`/v1/admin/api-keys/${id}`, { method: 'DELETE', headers: admin });
    expect(res.status).toBe(200);
    const revoked = (await res.json()) as { revokedAt: string | null };
    expect(revoked.revokedAt).toBe('2026-09-27T12:00:00.000Z');
    expect((await app.request('/openapi.json', { headers: bearer(clientKey) })).status).toBe(404);

    const again = await app.request(`/v1/admin/api-keys/${id}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(again.status).toBe(200);

    const missing = await app.request('/v1/admin/api-keys/nope', {
      method: 'DELETE',
      headers: admin,
    });
    expect(missing.status).toBe(404);
    expect(await problemOf(missing)).toMatchObject({
      status: 404,
      detail: 'No API key with this id.',
    });
  });
});

describe('GET /v1/whoami', () => {
  it('identifies the calling key for client and admin keys, without secrets', async () => {
    const { app, keyFor, clock } = await testApp();
    const client = await keyFor('client');
    await keyFor('admin');
    const t0 = clock();
    const res = await app.request('/v1/whoami', { headers: bearer(client) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      id: expect.any(String) as string,
      scope: 'client',
      label: 'test client',
      createdAt: new Date(t0).toISOString(),
      lastUsed: new Date(t0).toISOString(),
    });
    expect(text).not.toContain(client);
    expect(text).not.toMatch(/[0-9a-f]{64}/);

    const admin = await keyFor('admin');
    const adminRes = await app.request('/v1/whoami', { headers: bearer(admin) });
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toMatchObject({ scope: 'admin' });
  });

  it('refuses a metrics key (403) and hides itself from a missing or revoked key (404)', async () => {
    const { app, keyFor, db } = await testApp();
    const metrics = await keyFor('metrics');
    const res = await app.request('/v1/whoami', { headers: bearer(metrics) });
    expect(res.status).toBe(403);
    expect(await problemOf(res)).toMatchObject({ status: 403, title: 'Forbidden' });

    expect((await app.request('/v1/whoami')).status).toBe(404);
    const client = await keyFor('client');
    await db.updateTable('api_keys').set({ revoked_at: 1 }).execute();
    expect((await app.request('/v1/whoami', { headers: bearer(client) })).status).toBe(404);
  });
});

describe('/metrics', () => {
  it('requires the metrics scope; admin also grants it', async () => {
    const { app, keyFor } = await testApp();
    const metrics = bearer(await keyFor('metrics'));
    const admin = bearer(await keyFor('admin'));
    const client = bearer(await keyFor('client'));

    const metricsRes = await app.request('/metrics', { headers: metrics });
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers.get('Content-Type')).toMatch(/text\/plain/i);
    const text = await metricsRes.text();
    expect(text).toContain('# HELP');

    const adminRes = await app.request('/metrics', { headers: admin });
    expect(adminRes.status).toBe(200);

    const clientRes = await app.request('/metrics', { headers: client });
    expect(clientRes.status).toBe(403);
    expect(await problemOf(clientRes)).toMatchObject({
      status: 403,
      detail: "This route needs the 'metrics' scope.",
    });

    const noKeyRes = await app.request('/metrics');
    expect(noKeyRes.status).toBe(404);
  });
});

describe('request logging', () => {
  it('logs method, route pattern, status and duration, never paths or query strings', async () => {
    const { app, keyFor, log } = await testApp();
    const admin = bearer(await keyFor('admin'));
    await app.request('/v1/admin/api-keys/some-secret-id?token=hunter2', {
      method: 'DELETE',
      headers: admin,
    });
    await app.request('/nope?x=1');
    log.logger.flush();

    const requests = log.lines().filter((line) => line.msg === 'request');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      route: '/v1/admin/api-keys/:id',
      status: 404,
    });
    expect(typeof requests[0]?.durationMs).toBe('number');
    expect(typeof requests[0]?.reqId).toBe('string');
    expect(requests[1]).toMatchObject({ method: 'GET', route: '(unmatched)', status: 404 });
    expect(log.text()).not.toContain('hunter2');
    expect(log.text()).not.toContain('some-secret-id');
  });

  it('logs unhandled errors and answers a bare 500 problem', async () => {
    const { app, db, log } = await testApp();
    // Break the table the admin route reads.
    await sql`drop table api_keys`.execute(db);
    const res = await app.request('/v1/admin/api-keys', { headers: bearer('A'.repeat(43)) });
    expect(res.status).toBe(500);
    expect(await problemOf(res)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
    });
    log.logger.flush();
    expect(log.lines().some((line) => line.msg === 'unhandled error')).toBe(true);
  });
});
