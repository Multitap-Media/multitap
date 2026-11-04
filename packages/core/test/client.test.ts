/**
 * The generated client (`@multitap/api`'s createMultitapClient) against Multitap's app,
 * in process. Lives here, not in packages/api, because nothing may import
 * packages/core (dependency-cruiser).
 */
import { createMultitapClient } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.ts';

async function clientFor(scope: 'client' | 'admin') {
  const t = await testApp();
  const requests: Request[] = [];
  const multitap = createMultitapClient({
    baseUrl: 'http://core.test/',
    apiKey: await t.keyFor(scope),
    fetch: async (request) => {
      requests.push(request.clone());
      return t.app.fetch(request);
    },
  });
  return { ...t, multitap, requests };
}

describe('createMultitapClient', () => {
  it('sends the API key and parses typed JSON', async () => {
    const { multitap, requests } = await clientFor('admin');
    const { data, error, response } = await multitap.POST('/v1/admin/api-keys', {
      body: { scope: 'client', label: 'party' },
    });
    expect(error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(data?.scope).toBe('client');
    expect(data?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(requests[0]?.url).toBe('http://core.test/v1/admin/api-keys');
    expect(requests[0]?.headers.get('authorization')).toMatch(/^Bearer /);

    const list = await multitap.GET('/v1/admin/api-keys');
    // Both keys share the manual clock's timestamp, so compare without order.
    expect(list.data?.map((key) => key.label).sort()).toEqual(['party', 'test admin']);
  });

  it('fills path and query parameters', async () => {
    const { multitap, requests } = await clientFor('client');
    const { data, error } = await multitap.GET('/v1/streams/{type}/{videoId}', {
      params: { path: { type: 'series', videoId: 'tt0903747:1:1' }, query: { engine: 'nope' } },
    });
    expect(data).toBeUndefined();
    // An unknown engine is a documented 400, typed as a problem.
    expect(error).toMatchObject({ status: 400, title: 'Bad Request' });
    expect(requests[0]?.url).toBe(
      'http://core.test/v1/streams/series/tt0903747%3A1%3A1?engine=nope',
    );
  });

  it('refuses a "." or ".." path parameter instead of calling another route', async () => {
    const { multitap, requests } = await clientFor('client');
    for (const subject of ['.', '..']) {
      // `…/tokens/..` would be `DELETE /v1/sessions/{id}`: releasing the session.
      await expect(
        multitap.DELETE('/v1/sessions/{id}/tokens/{subject}', {
          params: { path: { id: 'ps_x', subject } },
        }),
      ).rejects.toThrow(/Path parameter "subject" is "\.{1,2}"/);
    }
    expect(requests).toEqual([]);
    // Dots inside a value are sent as they are.
    await multitap.GET('/v1/meta/{type}/{id}', {
      params: { path: { type: 'movie', id: '...' } },
    });
    expect(requests[0]?.url).toBe('http://core.test/v1/meta/movie/...');
  });

  it('returns problems for a missing scope', async () => {
    const { multitap } = await clientFor('client');
    const forbidden = await multitap.GET('/v1/admin/engines');
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.error?.status).toBe(403);

    const catalogs = await multitap.GET('/v1/catalogs');
    expect(catalogs.data).toEqual([]);
  });
});
