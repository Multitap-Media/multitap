/**
 * A media token minted while its subject is being revoked stays revoked for as
 * long as it lives (okf:concept/media-tokens). Was the review's mint/revoke race
 * (okf:core-review/sec-access-progress): the denylist entry lasted only as long
 * as the subject's earlier tokens, so a longer token minted in the race came
 * back to life when the entry lapsed.
 */
import { afterEach, expect, it } from 'vitest';
import { JoseTokenService } from '../src/gateway/tokens.ts';
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
