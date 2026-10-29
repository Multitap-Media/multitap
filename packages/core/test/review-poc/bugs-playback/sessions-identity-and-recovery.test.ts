/**
 * Review PoC (bugs-playback): playback session idempotency and restart recovery.
 *
 * 1. The idempotency identity leaves out `highRes` and the engine, so a create
 *    asking for another engine or high-res policy under the same key gets the
 *    old session back (`created: false`).
 * 2. A session left `resolving` by a crash after its engine session was created
 *    (engine_sessions row written, playback session not yet ready) is failed
 *    `interrupted` on start; its retention release then has no handle, so the
 *    engine session is never deleted and its row stays forever.
 */
import { afterEach, expect, it } from 'vitest';
import { putEngine } from '../../../src/engines/index.ts';
import { HOME_ENGINE } from '../../engine-fixture.ts';
import { MOVIE, httpStream, sessionRig, type Rig } from '../../session-setup.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});
async function rig() {
  const r = await sessionRig();
  rigs.push(r);
  return r;
}

it.fails('a create with the same key but another highRes policy is a new session', async () => {
  const r = await rig();
  r.auto(httpStream('a'));
  const base = { key: 'room:1', item: MOVIE, source: { auto: true as const } };
  await r.service.create({ ...base, highRes: 'off' });
  await r.settle();
  const second = await r.service.create({ ...base, highRes: 'on' });
  expect(second.session.highRes).toBe('on');
  expect(second.created).toBe(true);
});

it.fails(
  'a create with the same key but another engine is a new session on that engine',
  async () => {
    const r = await rig();
    await putEngine(r.db, 'second', { ...HOME_ENGINE, address: 'http://engine2.test:11470' });
    const key = r.list(httpStream('a'));
    const base = { key: 'room:1', item: MOVIE, source: { key } };
    await r.service.create({ ...base, engine: 'home' });
    await r.settle();
    const second = await r.service.create({ ...base, engine: 'second' });
    expect(second.session.engineId).toBe('second');
  },
);

it.fails('an engine session created before a crash is released once its session ends', async () => {
  const r = await rig();
  const key = r.list(httpStream('a'));
  const { session } = await r.service.create({ item: MOVIE, source: { key } });
  await r.settle();
  const ready = await r.repo.get(session.id);
  const sid = ready?.sid;
  if (!sid) throw new Error('expected an engine session id');
  // The state a crash between the engine's master answer (row written) and
  // commitReady leaves: still resolving, no sid on the playback session.
  await r.repo.update(session.id, { status: 'resolving', sid: null }, r.clock());

  // "Restart": start() fails it as interrupted; then retention releases it.
  await r.service.start();
  await r.settle();
  expect((await r.repo.get(session.id))?.failureReason).toBe('interrupted');
  r.clock.advance(r.config.sessions.retentionIdleMs + 1);
  await r.service.sweep();
  await r.settle();
  expect((await r.repo.get(session.id))?.status).toBe('released');

  const rows = await r.db.selectFrom('engine_sessions').select('sid').execute();
  // The engine session should be deleted on the engine and its row forgotten.
  expect(r.fake.deletes).toContain(sid);
  expect(rows.map((row) => row.sid)).not.toContain(sid);
});
