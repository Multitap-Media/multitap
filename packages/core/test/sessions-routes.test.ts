/**
 * `/v1/sessions` over HTTP (phase 2 step 4): status codes and problems for
 * every outcome, idempotent creates, the OpenAPI declarations, and no secret
 * in any response.
 */
import { PlaybackSessionSchema, type PlaybackSession } from '@multitap/api';
import { afterEach, describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/http/app.ts';
import { PROBLEM_CONTENT_TYPE } from '../src/http/problem.ts';
import { bearer } from './helpers.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});

async function setup() {
  const r = await sessionRig();
  rigs.push(r);
  const key = await r.keyFor('client');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await r.app.request(path, {
      method,
      headers: {
        ...bearer(key),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get('Content-Type'),
      text,
      json: () => JSON.parse(text) as Record<string, unknown>,
    };
  };
  return { r, key, call };
}

describe('/v1/sessions', () => {
  it('creates (201), returns the same session for the same identity (200), reads, patches, deletes', async () => {
    const { r, call } = await setup();
    const candidate = r.list(httpStream('good'));
    const body = { key: 'room:1', item: MOVIE, source: { key: candidate } };

    const created = await call('POST', '/v1/sessions', body);
    expect(created.status).toBe(201);
    const session = PlaybackSessionSchema.parse(created.json());
    expect(session.status).toBe('resolving');
    const again = await call('POST', '/v1/sessions', body);
    expect(again.status).toBe(200);
    expect(again.json().id).toBe(session.id);

    await r.settle();
    const read = await call('GET', `/v1/sessions/${session.id}`);
    expect(read.status).toBe(200);
    expect(PlaybackSessionSchema.parse(read.json())).toMatchObject({
      status: 'ready',
      chosen: candidate,
    });
    expect(read.text).not.toContain('media.example');

    const until = '2026-10-01T06:00:00.000Z';
    const patched = await call('PATCH', `/v1/sessions/${session.id}`, { retainUntil: until });
    expect(patched.status).toBe(200);
    expect(patched.json().retainUntil).toBe(until);

    expect((await call('DELETE', `/v1/sessions/${session.id}`)).status).toBe(204);
    expect((await call('DELETE', `/v1/sessions/${session.id}`)).status).toBe(204);
    const released = (await call('GET', `/v1/sessions/${session.id}`)).json() as PlaybackSession;
    expect(released.status).toBe('released');
    const gone = await call('PATCH', `/v1/sessions/${session.id}`, { retainUntil: null });
    expect(gone.status).toBe(410);
    expect(gone.type).toBe(PROBLEM_CONTENT_TYPE);
  });

  it('answers problems: 409 expired key, 422 other item, 400 unknown engine or bad body, 501, 404', async () => {
    const { r, call } = await setup();
    const expired = await call('POST', '/v1/sessions', { item: MOVIE, source: { key: 'gone' } });
    expect(expired.status).toBe(409);
    expect(expired.json().detail).toContain('list the sources again');

    const other = r.list(httpStream('x'), { type: 'movie', id: 'tt0000002' });
    expect(
      (await call('POST', '/v1/sessions', { item: MOVIE, source: { key: other } })).status,
    ).toBe(422);
    expect(
      (await call('POST', '/v1/sessions', { item: MOVIE, source: { auto: true }, engine: 'nope' }))
        .status,
    ).toBe(400);
    for (const bad of [
      { item: MOVIE, source: { auto: false } },
      { item: MOVIE, source: { auto: true }, quality: { maxHeight: 100 } },
      { item: MOVIE, source: { auto: true }, quality: { bitrate: 1_000 } },
      { item: MOVIE, source: { auto: true }, delivery: 'hls' },
    ]) {
      expect((await call('POST', '/v1/sessions', bad)).status).toBe(400);
    }
    for (const extra of [
      { mode: 'full' },
      { readyBy: '2026-10-01T20:00:00.000Z' },
      { delivery: 'direct' },
      { delivery: 'remux' },
    ]) {
      const res = await call('POST', '/v1/sessions', {
        item: MOVIE,
        source: { auto: true },
        ...extra,
      });
      expect(res.status).toBe(501);
      expect(res.type).toBe(PROBLEM_CONTENT_TYPE);
    }
    const full = await call('POST', '/v1/sessions', {
      item: MOVIE,
      source: { auto: true },
      mode: 'full',
    });
    expect(full.json().detail).toContain('not built yet');

    expect((await call('GET', '/v1/sessions/ps_nope')).status).toBe(404);
    expect((await call('PATCH', '/v1/sessions/ps_nope', { retainUntil: null })).status).toBe(404);
    expect((await call('DELETE', '/v1/sessions/ps_nope')).status).toBe(404);

    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    const ready = await call('PATCH', `/v1/sessions/${session.id}`, {
      readyBy: '2026-10-01T20:00:00.000Z',
    });
    expect(ready.status).toBe(501);
  });

  it('needs a key', async () => {
    const { r } = await setup();
    expect((await r.app.request('/v1/sessions/ps_x')).status).toBe(404);
  });
});

describe('sessions and events in the OpenAPI document', () => {
  it('declares the routes with their problem responses', () => {
    const doc = openApiDocument();
    const paths = doc.paths ?? {};
    const codes = (op: { responses?: Record<string, unknown> } | undefined) =>
      Object.keys(op?.responses ?? {}).sort();
    expect(codes(paths['/v1/sessions']?.post)).toEqual(
      ['200', '201', '400', '403', '404', '409', '422', '501', '503'].sort(),
    );
    expect(codes(paths['/v1/sessions/{id}']?.get)).toEqual(['200', '400', '403', '404']);
    expect(codes(paths['/v1/sessions/{id}']?.patch)).toEqual(
      ['200', '400', '403', '404', '410', '501'].sort(),
    );
    expect(codes(paths['/v1/sessions/{id}']?.delete)).toEqual(['204', '400', '403', '404']);
    expect(codes(paths['/v1/events']?.get)).toEqual(['200', '400', '403', '404', '503']);
    const sse: unknown = paths['/v1/events']?.get?.responses?.['200'];
    expect(sse).toHaveProperty(['content', 'text/event-stream']);
    expect(codes(paths['/v1/streams/{type}/{videoId}']?.get)).toContain('202');
    const schemas = doc.components?.schemas ?? {};
    for (const name of ['PlaybackSession', 'CreateSession', 'UpdateSession', 'SourceListStarted']) {
      expect(schemas, name).toHaveProperty(name);
    }
  });
});
