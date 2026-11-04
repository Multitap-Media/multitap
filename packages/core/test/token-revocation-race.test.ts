/**
 * A media token minted while its subject is being revoked stays revoked for as
 * long as it lives (okf:concept/media-tokens). Was the review's mint/revoke race
 * (okf:core-review/sec-access-progress): the denylist entry lasted only as long
 * as the subject's earlier tokens, so a longer token minted in the race came
 * back to life when the entry lapsed.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { JoseTokenService, UNKNOWN_SESSION_CACHE_TTL_MS } from '../src/gateway/tokens.ts';
import { ProblemError } from '../src/http/problem.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

const SECRET = 'token-revocation-race-secret-0123456789abcdef';
const HOUR = 3_600_000;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.service.stop();
    await r.settle();
    await r.db.destroy();
  }
});

async function setup() {
  const r = await sessionRig({ env: { MULTITAP_MEDIA_TOKEN_SECRET: SECRET } });
  rigs.push(r);
  const { session } = await r.service.create({
    item: MOVIE,
    source: { key: r.list(httpStream('good')) },
  });
  await r.settle();
  const tokens = new JoseTokenService({
    secret: SECRET,
    previousSecret: null,
    maxTtlMs: r.config.media.tokenMaxTtlMs,
    repo: r.repo,
    sessions: r.service,
    clock: r.clock,
    logger: r.log.logger,
  });
  return { r, tokens, sessionId: session.id };
}

it('a token minted after the route checked the denylist, but after a revocation, never works', async () => {
  const { r, tokens, sessionId } = await setup();
  // The subject's current token: 1 h.
  await tokens.mint(sessionId, 'member-x', 0, HOUR);
  // POST /v1/sessions/{id}/tokens checks the denylist first…
  expect(tokens.revokedUntil(sessionId, 'member-x')).toBeUndefined();
  // …meanwhile DELETE /v1/sessions/{id}/tokens/member-x runs…
  await tokens.revokeSubject(sessionId, 'member-x');
  // …then the route mints an 8 h token for the revoked subject.
  const fresh = await tokens.mint(sessionId, 'member-x', 0, 8 * HOUR);
  expect((await tokens.verify(fresh.token)).ok).toBe(false);
  // The revocation now lasts as long as that token: past the 1 h one…
  r.clock.advance(HOUR + 1_000);
  expect((await tokens.verify(fresh.token)).ok).toBe(false);
  // …and it is persisted, so a restarted service still refuses the token.
  const restarted = new JoseTokenService({
    secret: SECRET,
    previousSecret: null,
    maxTtlMs: r.config.media.tokenMaxTtlMs,
    repo: r.repo,
    sessions: r.service,
    clock: r.clock,
    logger: r.log.logger,
  });
  expect((await restarted.verify(fresh.token)).ok).toBe(false);
  expect(restarted.revokedUntil(sessionId, 'member-x')).toBe(fresh.expiresAt);
});

it('a revocation that lands while a token is being signed covers that token', async () => {
  const { r, tokens, sessionId } = await setup();
  await tokens.mint(sessionId, 'member-y', 0, HOUR);
  const minting = tokens.mint(sessionId, 'member-y', 0, 8 * HOUR);
  await tokens.revokeSubject(sessionId, 'member-y');
  const fresh = await minting;
  expect((await tokens.verify(fresh.token)).ok).toBe(false);
  r.clock.advance(HOUR + 1_000);
  expect((await tokens.verify(fresh.token)).ok).toBe(false);
});

/** A token service whose record reads wait for `release()`, observing the session's changes. */
function gatedTokens(r: Rig) {
  const held: (() => void)[] = [];
  let reads = 0;
  const tokens = new JoseTokenService({
    secret: SECRET,
    previousSecret: null,
    maxTtlMs: r.config.media.tokenMaxTtlMs,
    repo: r.repo,
    sessions: {
      getRecord: async (id) => {
        reads++;
        const record = await r.service.getRecord(id);
        await new Promise<void>((resolve) => held.push(resolve));
        return record;
      },
      bumpTokenEpoch: (id) => r.service.bumpTokenEpoch(id),
    },
    clock: r.clock,
    logger: r.log.logger,
  });
  r.service.onChange((record) => {
    tokens.observe(record);
  });
  const waitForRead = () =>
    vi.waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    });
  const release = () => {
    for (const resolve of held.splice(0)) resolve();
  };
  return { tokens, waitForRead, release, reads: () => reads };
}

it('a record read before a revoke-all, observed after it, does not bring old tokens back', async () => {
  const { r, sessionId } = await setup();
  const { tokens, waitForRead, release } = gatedTokens(r);
  const old = await tokens.mint(sessionId, 'member-z', 0, HOUR);
  // A media request reads the record (epoch 0)…
  const verifying = tokens.verify(old.token);
  await waitForRead();
  // …revoke-all lands meanwhile (epoch 1, observed through onChange)…
  expect(await tokens.revokeAll(sessionId)).toBe(1);
  // …then the stale read is observed.
  release();
  await verifying;
  expect(await tokens.verify(old.token)).toEqual({ ok: false, reason: 'revoked' });
  const fresh = await tokens.mint(sessionId, 'member-z', 1, HOUR);
  expect((await tokens.verify(fresh.token)).ok).toBe(true);
});

it('a record read before a release, observed after it, keeps the session released', async () => {
  const { r, sessionId } = await setup();
  const { tokens, waitForRead, release } = gatedTokens(r);
  const token = await tokens.mint(sessionId, 'member-z', 0, HOUR);
  const verifying = tokens.verify(token.token);
  await waitForRead();
  await r.service.release(sessionId, 'request');
  release();
  await verifying;
  expect(await tokens.verify(token.token)).toEqual({ ok: false, reason: 'released' });
});

it('remembers an unknown session briefly instead of reading it on every request', async () => {
  const { r } = await setup();
  const { tokens, waitForRead, release, reads } = gatedTokens(r);
  const orphan = await tokens.mint('ps_deleted', 'member-z', 0, HOUR);
  const first = tokens.verify(orphan.token);
  await waitForRead();
  release();
  expect(await first).toEqual({ ok: false, reason: 'unknown-session' });
  expect(await tokens.verify(orphan.token)).toEqual({ ok: false, reason: 'unknown-session' });
  expect(reads()).toBe(1);
  r.clock.advance(UNKNOWN_SESSION_CACHE_TTL_MS);
  const again = tokens.verify(orphan.token);
  await waitForRead();
  release();
  expect(await again).toEqual({ ok: false, reason: 'unknown-session' });
  expect(reads()).toBe(2);
});

it('revoke-all of a session that vanished is a 404 problem', async () => {
  const { tokens } = await setup();
  await expect(tokens.revokeAll('ps_gone')).rejects.toMatchObject({
    name: 'ProblemError',
    status: 404,
  });
});

it('a revocation that could not be stored is in force, logged, and a 503 problem', async () => {
  const { r, sessionId } = await setup();
  const tokens = new JoseTokenService({
    secret: SECRET,
    previousSecret: null,
    maxTtlMs: r.config.media.tokenMaxTtlMs,
    repo: {
      listRevocations: (now) => r.repo.listRevocations(now),
      revokeSubject: () => Promise.reject(new Error('database is locked')),
    },
    sessions: r.service,
    clock: r.clock,
    logger: r.log.logger,
  });
  const token = await tokens.mint(sessionId, 'member-w', 0, HOUR);
  await expect(tokens.revokeSubject(sessionId, 'member-w')).rejects.toBeInstanceOf(ProblemError);
  await expect(tokens.revokeSubject(sessionId, 'member-w')).rejects.toMatchObject({ status: 503 });
  expect(await tokens.verify(token.token)).toEqual({ ok: false, reason: 'revoked' });
  expect(r.log.lines()).toContainEqual(
    expect.objectContaining({
      level: 50,
      sessionId,
      subject: 'member-w',
      msg: 'media token revocation in force but not stored: it ends if Multitap restarts',
    }),
  );
});
