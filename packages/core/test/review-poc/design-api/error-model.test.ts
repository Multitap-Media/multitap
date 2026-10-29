// Review PoC (design-api): problem bodies carry no machine-readable kind.
// Every problem is `type: 'about:blank'`, so a client can tell different
// failures with the same status apart only by parsing the English `detail`.
import { describe, expect, it } from 'vitest';
import { bearer, testApp } from '../../helpers.ts';

describe('design-api PoC: problem types', () => {
  it.fails(
    'gives an unknown profile and a validation failure different problem types',
    async () => {
      const { app, keyFor } = await testApp();
      const key = await keyFor('client');
      const unknownProfile = await app.request('/v1/streams/movie/tt0000001?profileId=pr_nope', {
        headers: bearer(key),
      });
      const invalid = await app.request('/v1/streams/movie/tt0000001?sort=bogus', {
        headers: bearer(key),
      });
      expect(unknownProfile.status).toBe(400);
      expect(invalid.status).toBe(400);
      const a = (await unknownProfile.json()) as { type: string };
      const b = (await invalid.json()) as { type: string };
      // Fails today: both are 'about:blank'.
      expect(a.type).not.toBe(b.type);
    },
  );

  it.fails('lets a client tell a revoked key from a missing resource', async () => {
    const { app, keyFor } = await testApp();
    const key = await keyFor('client');
    const missing = await app.request('/v1/profiles/pr_nope', { headers: bearer(key) });
    const badKey = await app.request('/v1/profiles', { headers: bearer('not-a-key') });
    expect(missing.status).toBe(404);
    expect(badKey.status).toBe(404);
    const a = (await missing.json()) as Record<string, unknown>;
    const b = (await badKey.json()) as Record<string, unknown>;
    // Fails today: same status, same type, same title; no WWW-Authenticate.
    expect([a.type, badKey.headers.get('WWW-Authenticate')]).not.toEqual([b.type, null]);
  });
});
