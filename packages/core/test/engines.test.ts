import { EngineDescriptorSchema, type EngineInput } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import {
  checkEngines,
  defaultEngineId,
  deleteEngine,
  getEngine,
  getEngineProxyPassword,
  listEngines,
  NoDefaultEngineError,
  putEngine,
} from '../src/engines/index.ts';
import { HOME_ENGINE, addHomeEngine } from './engine-fixture.ts';
import { bearer, memoryLogger, migratedMemoryDb, testApp } from './helpers.ts';

const input: EngineInput = {
  name: 'Alex PC',
  transport: 'tunnel',
  address: 'http://alex.example.invalid:11470',
  capabilities: {
    hwaccel: 'nvenc',
    liveMaxHeight: 2160,
    preparedMaxHeight: 2160,
    tonemap: true,
    sessionOverrides: false,
    liveConcurrency: 2,
    prepareConcurrency: 1,
  },
  localAddon: true,
};

describe('engine store', () => {
  it('starts with no engine, and the only one is the default', async () => {
    const db = await migratedMemoryDb();
    expect(await listEngines(db)).toEqual([]);
    await expect(defaultEngineId(db, undefined)).rejects.toThrow(NoDefaultEngineError);
    await expect(defaultEngineId(db, undefined)).rejects.toThrow('PUT /v1/admin/engines/{id}');
    // A configured default is used as is; an unknown id is the caller's 400.
    expect(await defaultEngineId(db, 'alex-pc')).toBe('alex-pc');

    await putEngine(db, 'alex-pc', input);
    expect(await defaultEngineId(db, undefined)).toBe('alex-pc');
    await addHomeEngine(db);
    await expect(defaultEngineId(db, undefined)).rejects.toThrow(
      'MULTITAP_SELECTION_DEFAULT_ENGINE',
    );
    expect(await defaultEngineId(db, 'home')).toBe('home');
    expect((await listEngines(db)).find((e) => e.id === 'home')).toEqual(HOME_ENGINE);
  });

  it('warns at startup when requests without an engine cannot play', async () => {
    const db = await migratedMemoryDb();
    const log = memoryLogger();
    await checkEngines(db, undefined, log.logger);
    expect(log.lines().at(-1)?.msg).toContain('no engine configured');
    await putEngine(db, 'alex-pc', input);
    await checkEngines(db, 'home', log.logger);
    expect(log.lines().at(-1)).toMatchObject({ engineId: 'home' });
    await addHomeEngine(db);
    await checkEngines(db, undefined, log.logger);
    expect(log.lines().at(-1)).toMatchObject({ engines: ['alex-pc', 'home'] });
    const before = log.lines().length;
    await checkEngines(db, 'home', log.logger);
    expect(log.lines()).toHaveLength(before);
  });

  it('creates, replaces, reads and deletes', async () => {
    const db = await migratedMemoryDb();
    expect(await putEngine(db, 'alex-pc', input)).toMatchObject({ created: true });
    expect(await getEngine(db, 'alex-pc')).toEqual({ id: 'alex-pc', ...input });
    const withoutLocal: EngineInput = { ...input };
    delete withoutLocal.localAddon;
    expect(await putEngine(db, 'alex-pc', { ...withoutLocal, name: 'Alex' })).toMatchObject({
      created: false,
      engine: { name: 'Alex', localAddon: false },
    });
    expect((await getEngine(db, 'alex-pc'))?.localAddon).toBe(false);
    expect(await deleteEngine(db, 'alex-pc')).toBe(true);
    expect(await deleteEngine(db, 'alex-pc')).toBe(false);
    expect(await getEngine(db, 'alex-pc')).toBeUndefined();
  });
});

describe('/v1/admin/engines', () => {
  async function setup() {
    const t = await testApp();
    await addHomeEngine(t.db);
    const admin = bearer(await t.keyFor('admin'));
    const json = (body: unknown) => ({
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ...t, admin, json };
  }

  it('lists and gets engines', async () => {
    const { app, admin } = await setup();
    const list = await app.request('/v1/admin/engines', { headers: admin });
    expect(list.status).toBe(200);
    const body = (await list.json()) as unknown[];
    // The API view adds health: offline until a check has answered.
    const homeView = { ...HOME_ENGINE, online: false, lastSeen: null, proxyPasswordSet: false };
    expect(body).toEqual([homeView]);
    expect(EngineDescriptorSchema.array().safeParse(body).success).toBe(true);

    const one = await app.request('/v1/admin/engines/home', { headers: admin });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(homeView);

    const missing = await app.request('/v1/admin/engines/nope', { headers: admin });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toBe('application/problem+json');
  });

  it('PUT creates (201) then replaces (200)', async () => {
    const { app, json } = await setup();
    const created = await app.request('/v1/admin/engines/alex-pc', {
      method: 'PUT',
      ...json(input),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: 'alex-pc',
      ...input,
      online: false,
      lastSeen: null,
      proxyPasswordSet: false,
    });
    const replaced = await app.request('/v1/admin/engines/alex-pc', {
      method: 'PUT',
      ...json({ ...input, name: 'Alex 2' }),
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ id: 'alex-pc', name: 'Alex 2' });
  });

  it('PUT validates the id and body', async () => {
    const { app, json } = await setup();
    const badId = await app.request('/v1/admin/engines/Bad_Id', { method: 'PUT', ...json(input) });
    expect(badId.status).toBe(400);
    const badBody = await app.request('/v1/admin/engines/x', {
      method: 'PUT',
      ...json({ ...input, capabilities: { ...input.capabilities, liveMaxHeight: -1 } }),
    });
    expect(badBody.status).toBe(400);
    const badTransport = await app.request('/v1/admin/engines/x', {
      method: 'PUT',
      ...json({ ...input, transport: 'carrier-pigeon' }),
    });
    expect(badTransport.status).toBe(400);
  });

  it('DELETE refuses the configured default engine, deletes others, 404s unknown ones', async () => {
    const { app, admin, json, config } = await setup();
    config.selection.defaultEngine = 'home';
    const refused = await app.request('/v1/admin/engines/home', {
      method: 'DELETE',
      headers: admin,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: 409, title: 'Conflict' });

    await app.request('/v1/admin/engines/alex-pc', { method: 'PUT', ...json(input) });
    const deleted = await app.request('/v1/admin/engines/alex-pc', {
      method: 'DELETE',
      headers: admin,
    });
    expect(deleted.status).toBe(204);
    const again = await app.request('/v1/admin/engines/alex-pc', {
      method: 'DELETE',
      headers: admin,
    });
    expect(again.status).toBe(404);
  });

  it('a fresh install has no engine, and says how to add one', async () => {
    const t = await testApp();
    const client = { ...bearer(await t.keyFor('client')), 'Content-Type': 'application/json' };
    const streams = await t.app.request('/v1/streams/movie/tt0000001', { headers: client });
    expect(streams.status).toBe(400);
    expect(await streams.json()).toMatchObject({
      detail: expect.stringContaining('PUT /v1/admin/engines/{id}') as unknown,
    });
    const session = await t.app.request('/v1/sessions', {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ item: { type: 'movie', id: 'tt0000001' }, source: { auto: true } }),
    });
    expect(session.status).toBe(400);
    expect(await session.json()).toMatchObject({
      detail: expect.stringContaining('PUT /v1/admin/engines/{id}') as unknown,
    });
  });

  it('needs the admin scope', async () => {
    const { app, keyFor } = await setup();
    const client = bearer(await keyFor('client'));
    expect((await app.request('/v1/admin/engines', { headers: client })).status).toBe(403);
    expect((await app.request('/v1/admin/engines')).status).toBe(404);
  });
});

describe('proxy password (okf:architecture/secrets-classes-and-engine-password): write-only', () => {
  // A fake value only.
  const PASSWORD = 'FAKEproxyPASSWORD-0123456789';

  async function setup() {
    const t = await testApp();
    const admin = bearer(await t.keyFor('admin'));
    const put = (body: unknown) =>
      t.app.request('/v1/admin/engines/alex-pc', {
        method: 'PUT',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const stored = async () => (await getEngineProxyPassword(t.db, 'alex-pc'))?.reveal();
    return { ...t, admin, put, stored };
  }

  it('is accepted on PUT, stored, and shown only as proxyPasswordSet', async () => {
    const { app, admin, db, put, stored, log } = await setup();
    const created = await put({ ...input, proxyPassword: PASSWORD });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(PASSWORD);
    expect(JSON.parse(createdText)).toMatchObject({ id: 'alex-pc', proxyPasswordSet: true });
    expect(JSON.parse(createdText)).not.toHaveProperty('proxyPassword');
    expect(await stored()).toBe(PASSWORD);

    for (const path of ['/v1/admin/engines', '/v1/admin/engines/alex-pc']) {
      const res = await app.request(path, { headers: admin });
      const text = await res.text();
      expect(text).not.toContain(PASSWORD);
      expect(text).toContain('"proxyPasswordSet":true');
    }
    // The descriptor Multitap uses internally never carries it either.
    expect(JSON.stringify(await getEngine(db, 'alex-pc'))).not.toContain(PASSWORD);
    expect(log.text()).toContain('"proxyPasswordChange":"set"');
    expect(log.text()).not.toContain(PASSWORD);
  });

  it('a PUT without it keeps it; an empty string or null clears it', async () => {
    const { put, stored, log } = await setup();
    await put({ ...input, proxyPassword: PASSWORD });

    const kept = await put({ ...input, name: 'Renamed' });
    expect(await kept.json()).toMatchObject({ name: 'Renamed', proxyPasswordSet: true });
    expect(await stored()).toBe(PASSWORD);

    const cleared = await put({ ...input, proxyPassword: '' });
    expect(await cleared.json()).toMatchObject({ proxyPasswordSet: false });
    expect(await stored()).toBeUndefined();

    await put({ ...input, proxyPassword: PASSWORD });
    const nulled = await put({ ...input, proxyPassword: null });
    expect(await nulled.json()).toMatchObject({ proxyPasswordSet: false });
    expect(await stored()).toBeUndefined();
    expect(log.text()).toContain('"proxyPasswordChange":"kept"');
    expect(log.text()).toContain('"proxyPasswordChange":"cleared"');
    expect(log.text()).not.toContain(PASSWORD);
  });

  it('a new engine without it has none', async () => {
    const { put, stored } = await setup();
    expect(await (await put(input)).json()).toMatchObject({ proxyPasswordSet: false });
    expect(await stored()).toBeUndefined();
  });

  it('a rejected PUT never echoes it', async () => {
    const { put, stored } = await setup();
    const tooLong = `${PASSWORD}${'x'.repeat(1100)}`;
    const res = await put({ ...input, proxyPassword: tooLong });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(PASSWORD);
    const badOther = await put({ ...input, transport: 'carrier-pigeon', proxyPassword: PASSWORD });
    expect(badOther.status).toBe(400);
    expect(await badOther.text()).not.toContain(PASSWORD);
    expect(await stored()).toBeUndefined();
  });
});
