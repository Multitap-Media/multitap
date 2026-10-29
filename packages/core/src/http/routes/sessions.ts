/**
 * `/v1/sessions`: playback sessions (okf:architecture/playback-session, okf:architecture/rendition-and-bandwidth, okf:decision/auto-select-and-fallback, okf:architecture/engine-retention).
 * Client scope. Media tokens, viewers and session subtitles (okf:concept/media-tokens) are in
 * media-tokens.ts.
 *
 * Only ids, statuses and reasons are logged; candidate keys and raw streams
 * never are (okf:architecture/secrets-policy).
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { CreateSessionSchema, PlaybackSessionSchema, UpdateSessionSchema } from '@multitap/api';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SessionError, type SessionErrorCode } from '../../sessions/service.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import { sessionService } from '../selection-deps.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['sessions'];
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const SessionParams = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .openapi({ param: { name: 'id', in: 'path' }, example: 'ps_3q2x7wAbCdEfGhIjKlMnOp' }),
});

const noSession = 'No session with this id, or the API key is missing, invalid or revoked';

/**
 * OpenAPI links (okf:architecture/core-api-testing) for the session lifecycle: create → get/update → tokens,
 * viewers, subtitles → release.
 * Schemathesis's stateful phase follows them.
 */
const fromBody = { id: '$response.body#/id' };
const fromPath = { id: '$request.path.id' };
const sessionLinks = (id: Record<string, string>) => ({
  GetSession: {
    operationId: 'getSession',
    parameters: id,
    description: 'Read the session (`status`, `progress`).',
  },
  UpdateSession: {
    operationId: 'updateSession',
    parameters: id,
    description: "Set the session's retention.",
  },
  MintMediaToken: {
    operationId: 'mintMediaToken',
    parameters: id,
    description: 'Mint a media token for a viewer.',
  },
  RevokeAllMediaTokens: {
    operationId: 'revokeAllMediaTokens',
    parameters: id,
    description: 'Revoke every token of the session.',
  },
  ListSessionViewers: {
    operationId: 'listSessionViewers',
    parameters: id,
    description: "The session's viewers.",
  },
  ListSessionSubtitles: {
    operationId: 'listSessionSubtitles',
    parameters: id,
    description: "The session's subtitle tracks.",
  },
  ReleaseSession: {
    operationId: 'releaseSession',
    parameters: id,
    description: 'Release the session.',
  },
});

const STATUS: Record<SessionErrorCode, ContentfulStatusCode> = {
  'not-found': 404,
  released: 410,
  'candidate-expired': 409,
  'candidate-mismatch': 422,
  'unknown-engine': 400,
  'not-implemented': 501,
  'engine-busy': 503,
  'unknown-profile': 400,
};

/** Runs `fn`, turning a {@link SessionError} into its problem. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SessionError) {
      throw new ProblemError(
        STATUS[err.code],
        err.message,
        err.retryAfterSec === undefined ? undefined : { 'Retry-After': String(err.retryAfterSec) },
      );
    }
    throw err;
  }
}

const createSessionRoute = createRoute({
  method: 'post',
  path: '/v1/sessions',
  operationId: 'createSession',
  summary: 'Create a playback session',
  description:
    'Plays a picked source (`source: {key}`, a candidate key from `/v1/streams`; no fallback) or lets Multitap ' +
    'choose (`source: {auto: true}`: rank for the engine, try the playable candidates in order, stop after ' +
    '`MULTITAP_AUTO_SELECT_MAX_ATTEMPTS`, retry a failed torrent once after `MULTITAP_AUTO_SELECT_RETRY_AFTER_MS`). ' +
    "The engine is the candidate's affinity, else `engine`, else the default. " +
    "`quality` is capped at the engine's `liveMaxHeight` and `MULTITAP_SESSION_MAX_BITRATE`; with `maxHeight` and no " +
    '`bitrate`, Multitap derives a bitrate from the height (`MULTITAP_SESSION_BITRATE_BY_HEIGHT`). The resulting quality ' +
    "is part of the session's identity. Auto-select abandons a candidate that isn't ready within " +
    '`MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS`. ' +
    "The answer comes at once with `status: 'resolving'`; follow `session.status`, " +
    '`session.ready` and `session.failed` on `/v1/events?session={id}`, or poll the session. ' +
    'With a `key`, a create matching the key, item, source, delivery and quality of an open session ' +
    'returns that session with `200`. A new session on an engine already at its `liveConcurrency` is logged, or with `MULTITAP_ENGINE_ADMISSION=reject` refused with `503` and `Retry-After`.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateSessionSchema } } },
  },
  responses: {
    200: {
      ...json('An open session with the same identity (idempotent create)', PlaybackSessionSchema),
      links: sessionLinks(fromBody),
    },
    201: {
      ...json('The new session, resolving', PlaybackSessionSchema),
      links: sessionLinks(fromBody),
    },
    400: problemContent('The request failed validation, or the engine is unknown'),
    ...authResponses,
    409: problemContent('The candidate key has expired or is unknown: list the sources again'),
    422: problemContent("The candidate key belongs to another item's source list"),
    501: problemContent(
      "Not built yet: `mode: 'full'` and `readyBy`, `delivery` `direct` and `remux`",
    ),
    503: {
      ...problemContent(
        "`MULTITAP_ENGINE_ADMISSION=reject` only: the engine's resolving and playing sessions already reach its `liveConcurrency`",
      ),
      headers: {
        'Retry-After': {
          description: 'Seconds to wait before trying again (`MULTITAP_ENGINE_LOAD_WINDOW_MS`).',
          schema: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
});

const getSessionRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}',
  operationId: 'getSession',
  summary: 'Get a playback session',
  description:
    "A read counts as access for retention. Released sessions are kept for a while (`status: 'released'`).",
  tags,
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: { ...json('The session', PlaybackSessionSchema), links: sessionLinks(fromPath) },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
  },
});

const updateSessionRoute = createRoute({
  method: 'patch',
  path: '/v1/sessions/{id}',
  operationId: 'updateSession',
  summary: "Set a playback session's retention",
  description:
    'A session is kept until `max(retainUntil, lastAccess + MULTITAP_RETENTION_IDLE_MS)`; `null` clears `retainUntil`. ' +
    "Quality can't be changed: create another session.",
  tags,
  security: BEARER_SECURITY,
  request: {
    params: SessionParams,
    body: { required: true, content: { 'application/json': { schema: UpdateSessionSchema } } },
  },
  responses: {
    200: { ...json('The session', PlaybackSessionSchema), links: sessionLinks(fromPath) },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
    410: problemContent('The session has been released'),
    501: problemContent('`readyBy` needs preparation, which is not built yet'),
  },
});

const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/v1/sessions/{id}',
  operationId: 'releaseSession',
  summary: 'Release a playback session',
  description:
    'Ends the engine session and every token. The session stays readable as `released` for ' +
    '`MULTITAP_SESSION_RELEASED_KEEP_MS`, and its media answers `410`. Releasing again changes nothing.',
  tags,
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    204: { description: 'Released' },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
  },
});

/** `/v1/sessions` routes. The caller mounts the client-scope middleware. */
export function registerSessionRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid('json');
    const { session, created } = await mapped(() => sessionService(deps).create(body));
    deps.logger.info(
      { reqId: c.get('requestId'), sessionId: session.id, created },
      'session create',
    );
    return created ? c.json(session, 201) : c.json(session, 200);
  });

  app.openapi(getSessionRoute, async (c) => {
    const session = await sessionService(deps).get(c.req.valid('param').id);
    if (session === undefined) throw new ProblemError(404, 'No session with this id.');
    return c.json(session, 200);
  });

  app.openapi(updateSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const session = await mapped(() => sessionService(deps).update(id, body));
    return c.json(session, 200);
  });

  app.openapi(deleteSessionRoute, async (c) => {
    const session = await sessionService(deps).release(c.req.valid('param').id, 'request');
    if (session === undefined) throw new ProblemError(404, 'No session with this id.');
    return c.body(null, 204);
  });
}
