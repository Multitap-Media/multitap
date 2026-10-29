/**
 * Media tokens (okf:concept/media-tokens): HS256 JWTs signed with
 * `MULTITAP_MEDIA_TOKEN_SECRET` through `jose`, carrying `{sessionId, subject, epoch,
 * exp}`. Types only; phase 2 step 5 implements {@link TokenService}
 * (gateway/tokens.ts).
 *
 * Verification order: `jose` checks the signature with the algorithm pinned to
 * HS256 (the current secret, then `MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS`) and `exp`;
 * then in-memory state is checked: the session exists and isn't released, the
 * epoch matches its `tokenEpoch`, and the subject isn't revoked. No database
 * call per request.
 */

/** The JWT payload. `exp` is in seconds, as JWT requires. */
export interface MediaTokenClaims {
  sessionId: string;
  subject: string;
  epoch: number;
  exp: number;
}

export interface MintedToken {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * How a token check ended, mapped by the gateway to a status (okf:architecture/media-gateway):
 * `ok` → serve; `expired` → 401; `released` → 410; `invalid` (bad signature,
 * wrong algorithm, malformed), `revoked` (old epoch or revoked subject) and
 * `unknown-session` → 404, like any unknown path.
 */
export type TokenVerification =
  | { ok: true; claims: MediaTokenClaims }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'released' | 'unknown-session' };

export interface TokenService {
  /** Signs a token for the session's current epoch. `ttlMs` is already bounded by config. */
  mint(sessionId: string, subject: string, epoch: number, ttlMs: number): Promise<MintedToken>;
  verify(token: string): Promise<TokenVerification>;
  /** Denylists `subject` on the session until its last token could expire (persisted). */
  revokeSubject(sessionId: string, subject: string): Promise<void>;
  /** Bumps the session's epoch (persisted); returns the new epoch. */
  revokeAll(sessionId: string): Promise<number>;
  /** Called when a session is released or its epoch changes elsewhere, to refresh memory. */
  sessionChanged(sessionId: string): void;
}
