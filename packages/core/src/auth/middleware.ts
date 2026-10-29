import { createMiddleware } from 'hono/factory';
import type { Db } from '../db/index.ts';
import { notFoundResponse, problemResponse } from '../http/problem.ts';
import {
  scopeAllows,
  verifyApiKey,
  type ApiKeyPrincipal,
  type ApiKeyScope,
  type Clock,
} from './keys.ts';

export interface AuthVariables {
  apiKey: ApiKeyPrincipal;
}

const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * Requires `Authorization: Bearer <key>` with at least `scope` (okf:architecture/core-api-keys-security).
 * - Missing, malformed, unknown or revoked key: `404`, byte-for-byte the same
 *   problem as an unknown route, so the API doesn't reveal itself.
 * - Valid key without the scope: `403`.
 * Nested uses are cheap: a key already verified for this request is reused.
 */
export function requireScope(scope: ApiKeyScope, deps: { db: Db; clock: Clock }) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    let principal = c.get('apiKey') as ApiKeyPrincipal | undefined;
    if (principal === undefined) {
      const match = BEARER.exec(c.req.header('Authorization') ?? '');
      principal = match?.[1] ? await verifyApiKey(deps.db, match[1], deps.clock) : undefined;
      if (principal === undefined) return notFoundResponse(c);
      c.set('apiKey', principal);
    }
    if (!scopeAllows(principal.scope, scope)) {
      return problemResponse(c, 403, { detail: `This route needs the '${scope}' scope.` });
    }
    await next();
  });
}
