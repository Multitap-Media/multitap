/**
 * {@link TokenService} over `jose` (okf:concept/media-tokens, okf:architecture/media-gateway-proxy): HS256 JWTs
 * signed with `MULTITAP_MEDIA_TOKEN_SECRET`, verified with the algorithm pinned, then
 * checked against in-memory state (session released, `tokenEpoch`, the
 * subject denylist). No database call per media request once a session's
 * state is cached.
 *
 * Without a configured secret, a random per-process key signs (startup
 * warning): tokens then don't survive a restart.
 *
 * Tokens are never logged; at most their session id and subject are.
 */
import { randomBytes } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { Clock } from '../lib/clock.ts';
import { TtlCache } from '../lib/ttl-cache.ts';
import type { Logger } from '../log.ts';
import type { PlaybackSessionRecord, SessionRepository } from '../sessions/repository.ts';
import type {
  MediaTokenClaims,
  MintedToken,
  TokenService,
  TokenVerification,
} from './token-service.ts';

export const TOKEN_ALGORITHM = 'HS256';
/** A token longer than this is rejected before any crypto. */
export const MAX_TOKEN_LENGTH = 2_048;
/** Verified signatures are cached this long (okf:architecture/media-gateway-proxy). */
export const VERIFIED_CACHE_TTL_MS = 60_000;
export const VERIFIED_CACHE_MAX_ENTRIES = 10_000;

/** What the token service needs from playback sessions. */
export interface TokenSessions {
  getRecord(id: string): Promise<PlaybackSessionRecord | undefined>;
  bumpTokenEpoch(id: string): Promise<number | undefined>;
}

export interface JoseTokenServiceDeps {
  /** `MULTITAP_MEDIA_TOKEN_SECRET`; null = a random per-process key (with a warning). */
  secret: string | null;
  /** `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS`: accepted for verification only. */
  previousSecret: string | null;
  /** `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS`: how long a revocation must last when nothing better is known. */
  maxTtlMs: number;
  repo: Pick<SessionRepository, 'revokeSubject' | 'listRevocations'>;
  sessions: TokenSessions;
  clock: Clock;
  logger: Logger;
}

interface SessionState {
  released: boolean;
  epoch: number;
}

const encoder = new TextEncoder();
/** Base64url JWS compact form: three segments. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function claimsOf(payload: Record<string, unknown>): MediaTokenClaims | undefined {
  const { sessionId, subject, epoch, exp } = payload;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  if (typeof subject !== 'string' || subject === '') return undefined;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return { sessionId, subject, epoch, exp };
}

export class JoseTokenService implements TokenService {
  readonly #o: JoseTokenServiceDeps;
  readonly #key: Uint8Array;
  readonly #previousKey: Uint8Array | undefined;
  /** Session id → state; filled on first sight, kept current through {@link observe}. */
  readonly #sessions = new Map<string, SessionState>();
  /** Session id → subject → revoked until (ms). */
  readonly #revoked = new Map<string, Map<string, number>>();
  /** Session id → subject → latest `expiresAt` minted in this process. */
  readonly #minted = new Map<string, Map<string, number>>();
  readonly #verified: TtlCache<MediaTokenClaims>;
  readonly #startedAt: number;
  #loading: Promise<void> | undefined;

  constructor(deps: JoseTokenServiceDeps) {
    this.#o = deps;
    this.#startedAt = deps.clock();
    if (deps.secret === null) {
      this.#key = randomBytes(32);
      deps.logger.warn(
        'MULTITAP_MEDIA_TOKEN_SECRET is not set: media tokens are signed with a random per-process key ' +
          'and stop working when Multitap restarts. Set MULTITAP_MEDIA_TOKEN_SECRET (or MULTITAP_MEDIA_TOKEN_SECRET_FILE).',
      );
    } else {
      this.#key = encoder.encode(deps.secret);
    }
    this.#previousKey =
      deps.previousSecret === null ? undefined : encoder.encode(deps.previousSecret);
    this.#verified = new TtlCache({
      clock: deps.clock,
      ttlMs: VERIFIED_CACHE_TTL_MS,
      maxEntries: VERIFIED_CACHE_MAX_ENTRIES,
    });
  }

  /** Loads the revocations still in force. Runs once; every other method waits for it. */
  start(): Promise<void> {
    this.#loading ??= (async () => {
      for (const r of await this.#o.repo.listRevocations(this.#o.clock())) {
        this.#denylist(r.sessionId, r.subject, r.until);
      }
    })();
    return this.#loading;
  }

  async mint(
    sessionId: string,
    subject: string,
    epoch: number,
    ttlMs: number,
  ): Promise<MintedToken> {
    const exp = Math.floor((this.#o.clock() + ttlMs) / 1000);
    const token = await new SignJWT({ sessionId, subject, epoch })
      .setProtectedHeader({ alg: TOKEN_ALGORITHM })
      .setExpirationTime(exp)
      .sign(this.#key);
    const expiresAt = exp * 1000;
    let bySubject = this.#minted.get(sessionId);
    if (bySubject === undefined) {
      bySubject = new Map();
      this.#minted.set(sessionId, bySubject);
    }
    bySubject.set(subject, Math.max(bySubject.get(subject) ?? 0, expiresAt));
    // A revocation that landed while this token was being signed (the route
    // checks the denylist before minting) must outlive it, or the token would
    // work again once the shorter revocation lapses.
    const until = this.revokedUntil(sessionId, subject);
    if (until !== undefined && until < expiresAt) {
      this.#denylist(sessionId, subject, expiresAt);
      await this.#o.repo.revokeSubject({ sessionId, subject, until: expiresAt });
    }
    return { token, expiresAt };
  }

  async verify(token: string): Promise<TokenVerification> {
    if (token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) {
      return { ok: false, reason: 'invalid' };
    }
    await this.start();
    const now = this.#o.clock();
    let claims = this.#verified.get(token);
    if (claims === undefined) {
      const checked = await this.#checkSignature(token, now);
      if (!checked.ok) return checked;
      claims = checked.claims;
      this.#verified.set(token, claims);
    }
    // jose compares in whole seconds: expired once `exp <= now`.
    if (claims.exp * 1000 <= now) return { ok: false, reason: 'expired' };

    const state = await this.#state(claims.sessionId);
    if (state === undefined) return { ok: false, reason: 'unknown-session' };
    if (state.released) return { ok: false, reason: 'released' };
    if (claims.epoch !== state.epoch) return { ok: false, reason: 'revoked' };
    if (this.isRevoked(claims.sessionId, claims.subject)) return { ok: false, reason: 'revoked' };
    return { ok: true, claims };
  }

  /** Whether `subject` is on the session's denylist now. */
  isRevoked(sessionId: string, subject: string): boolean {
    const until = this.#revoked.get(sessionId)?.get(subject);
    return until !== undefined && until > this.#o.clock();
  }

  /** When the subject's revocation ends (ms), if it is revoked now. */
  revokedUntil(sessionId: string, subject: string): number | undefined {
    return this.isRevoked(sessionId, subject)
      ? this.#revoked.get(sessionId)?.get(subject)
      : undefined;
  }

  async revokeSubject(sessionId: string, subject: string): Promise<void> {
    await this.start();
    const now = this.#o.clock();
    // Until the last token this process minted for the subject expires. A
    // token from before this process started (signed with a configured
    // secret, for a session that existed then) lives at most until
    // start + MULTITAP_MEDIA_TOKEN_MAX_TTL_MS.
    let until = 0;
    if (this.#o.secret !== null) {
      const record = await this.#o.sessions.getRecord(sessionId);
      if (record !== undefined && record.createdAt < this.#startedAt) {
        until = this.#startedAt + this.#o.maxTtlMs;
      }
    }
    // Read after the await, and denylisted before the next one, so a token
    // minted meanwhile is either counted here or sees the revocation in mint().
    until = Math.max(until, this.#minted.get(sessionId)?.get(subject) ?? 0);
    if (until <= now) return;
    this.#denylist(sessionId, subject, until);
    await this.#o.repo.revokeSubject({ sessionId, subject, until });
  }

  async revokeAll(sessionId: string): Promise<number> {
    const epoch = await this.#o.sessions.bumpTokenEpoch(sessionId);
    if (epoch === undefined) throw new Error('no such session');
    const state = this.#sessions.get(sessionId);
    if (state !== undefined) state.epoch = Math.max(state.epoch, epoch);
    return epoch;
  }

  sessionChanged(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Keeps the cached state current from a session change (`SessionService.onChange`). */
  observe(record: PlaybackSessionRecord): void {
    this.#sessions.set(record.id, {
      released: record.status === 'released',
      epoch: record.tokenEpoch,
    });
    if (record.status === 'released') {
      // Every token of a released session is dead anyway (410).
      this.#minted.delete(record.id);
      this.#revoked.delete(record.id);
    }
  }

  async #checkSignature(
    token: string,
    now: number,
  ): Promise<
    { ok: true; claims: MediaTokenClaims } | { ok: false; reason: 'invalid' | 'expired' }
  > {
    const keys = this.#previousKey === undefined ? [this.#key] : [this.#key, this.#previousKey];
    for (const key of keys) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [TOKEN_ALGORITHM],
          currentDate: new Date(now),
          requiredClaims: ['exp'],
        });
        const claims = claimsOf(payload);
        return claims === undefined ? { ok: false, reason: 'invalid' } : { ok: true, claims };
      } catch (err) {
        // The signature was good (jose checks claims after it): don't try other keys.
        if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
        if (err instanceof joseErrors.JWSSignatureVerificationFailed) continue;
        return { ok: false, reason: 'invalid' };
      }
    }
    return { ok: false, reason: 'invalid' };
  }

  async #state(sessionId: string): Promise<SessionState | undefined> {
    const cached = this.#sessions.get(sessionId);
    if (cached !== undefined) return cached;
    const record = await this.#o.sessions.getRecord(sessionId);
    if (record === undefined) return undefined;
    this.observe(record);
    return this.#sessions.get(sessionId);
  }

  #denylist(sessionId: string, subject: string, until: number): void {
    let bySubject = this.#revoked.get(sessionId);
    if (bySubject === undefined) {
      bySubject = new Map();
      this.#revoked.set(sessionId, bySubject);
    }
    bySubject.set(subject, Math.max(bySubject.get(subject) ?? 0, until));
  }
}
