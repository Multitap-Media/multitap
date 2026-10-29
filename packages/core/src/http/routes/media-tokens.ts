/**
 * Media tokens, viewers and session subtitles under `/v1/sessions/{id}`
 * (okf:concept/media-tokens, okf:architecture/core-v1-api, okf:architecture/media-gateway-proxy). Client scope.
 *
 * Tokens are bearer credentials: they are returned once and never logged;
 * logs carry the session id and subject.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  MediaTokenSchema,
  MintTokenSchema,
  RevokeAllTokensSchema,
  SessionSubtitleListSchema,
  SubtitleOffsetSchema,
  ViewerListSchema,
  type MediaToken,
} from '@multitap/api';
import { MEDIA_PREFIX } from '../../gateway/app.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import { gatewayServices, sessionService } from '../selection-deps.ts';
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

const SubjectParams = SessionParams.extend({
  subject: z
    .string()
    .min(1)
    .max(200)
    .openapi({ param: { name: 'subject', in: 'path' }, example: 'living-room' }),
});

const SubtitleOffsetParams = SessionParams.extend({
  fileId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .openapi({
      param: { name: 'fileId', in: 'path' },
      description: "A track `id` from the session's subtitle list.",
      example: '3q2-7wAbCdEfGhIjKlMnOpQrStUvWxYz',
    }),
});

const noSession = 'No session with this id, or the API key is missing, invalid or revoked';

const mintTokenRoute = createRoute({
  method: 'post',
  path: '/v1/sessions/{id}/tokens',
  operationId: 'mintMediaToken',
  summary: 'Mint a media token for a viewer',
  description:
    "A token for one viewer (`subject`) of the session, valid for `ttl` seconds (default `MULTITAP_MEDIA_TOKEN_TTL_MS`, capped at `MULTITAP_MEDIA_TOKEN_MAX_TTL_MS`) and the session's current `tokenEpoch`. " +
    'Play `mediaUrl` (or `mediaPath` on the media listener). The token is a bearer credential in the path: ' +
    'an expired one gets `401` on media, a revoked one `404`, a released session `410`. ' +
    'A token can be minted before the session is `ready`; its media answers `404` until then. ' +
    'A revoked subject gets `409` until its revocation ends: use another subject.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: SessionParams,
    body: { required: true, content: { 'application/json': { schema: MintTokenSchema } } },
  },
  responses: {
    201: {
      ...json('The token', MediaTokenSchema),
      links: {
        RevokeMediaTokenSubject: {
          operationId: 'revokeMediaTokenSubject',
          parameters: { id: '$request.path.id', subject: '$response.body#/subject' },
          description: "Revoke this viewer's tokens.",
        },
      },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
    409: problemContent('This subject is revoked on this session'),
    410: problemContent('The session has been released'),
  },
});

const revokeSubjectRoute = createRoute({
  method: 'delete',
  path: '/v1/sessions/{id}/tokens/{subject}',
  operationId: 'revokeMediaTokenSubject',
  summary: "Revoke one viewer's tokens",
  description:
    'Every token for `subject` on this session stops working at once (media answers `404`); other viewers carry on. ' +
    'The revocation lasts until those tokens would have expired, and survives a restart. Revoking an unknown subject succeeds.',
  tags,
  security: BEARER_SECURITY,
  request: { params: SubjectParams },
  responses: {
    204: { description: 'Revoked' },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
  },
});

const revokeAllRoute = createRoute({
  method: 'post',
  path: '/v1/sessions/{id}/tokens/revoke-all',
  operationId: 'revokeAllMediaTokens',
  summary: 'Revoke every token of a session',
  description:
    "Bumps the session's `tokenEpoch`: every token minted before stops working (media answers `404`). Mint new ones afterwards.",
  tags,
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: json('The new epoch', RevokeAllTokensSchema),
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
  },
});

const viewersRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}/viewers',
  operationId: 'listSessionViewers',
  summary: "A session's viewers",
  description:
    'Per token subject: the last media file and video segment requested, and the bytes sent. ' +
    'Kept in memory: empty after a restart, and forgotten when the session is released (`410` afterwards).',
  tags,
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: json('The viewers seen so far', ViewerListSchema),
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
    410: problemContent('The session has been released'),
  },
});

const sessionSubtitlesRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{id}/subtitles',
  operationId: 'listSessionSubtitles',
  summary: "Addon subtitles for a session's item",
  description:
    "The addon subtitles for the session's item, with paths relative to the media base: a player loads " +
    '`/media/{token}/{path}` with its own token (from a `<track crossorigin>` too). Only files listed for ' +
    "this session's item are served there. The addons are also given the file's `videoHash`, `videoSize` and " +
    "`filename` when known (from the source's hints, else the engine's OpenSubtitles hash), so they can match " +
    "subtitles that are in sync with it. Each track reports the session's timing `offsetMs` for it " +
    '(`PUT …/subtitles/{fileId}/offset`).',
  tags,
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: {
      ...json('The tracks and every addon asked', SessionSubtitleListSchema),
      links: {
        SetSessionSubtitleOffset: {
          operationId: 'setSessionSubtitleOffset',
          parameters: { id: '$request.path.id', fileId: '$response.body#/subtitles/0/id' },
          description: "Set the first track's timing offset for the whole session.",
        },
        ClearSessionSubtitleOffset: {
          operationId: 'clearSessionSubtitleOffset',
          parameters: { id: '$request.path.id', fileId: '$response.body#/subtitles/0/id' },
          description: "Clear the first track's session offset.",
        },
      },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noSession),
    410: problemContent('The session has been released'),
  },
});

const offsetResponses = {
  ...validationResponse,
  ...authResponses,
  404: problemContent(
    `${noSession}, or the file is not one of the session's subtitle tracks (list them again)`,
  ),
  410: problemContent('The session has been released'),
};

const setSubtitleOffsetRoute = createRoute({
  method: 'put',
  path: '/v1/sessions/{id}/subtitles/{fileId}/offset',
  operationId: 'setSessionSubtitleOffset',
  summary: "Set a subtitle track's timing offset for the session",
  description:
    'Every viewer of the session gets the track shifted by `offsetMs` (signed milliseconds, positive later) ' +
    'from the media listener, with no player setting needed. The offset is stored with the session and survives a ' +
    "Multitap restart. A viewer's own `?offsetMs=` on the media request is added to it (the sum clamped to 600000 either " +
    'way). A cue that ends at or before 0 after a negative shift is dropped; a start before 0 becomes 0. ' +
    '`0` clears the offset. Players that cache the track must reload it to see a change.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: SubtitleOffsetParams,
    body: { required: true, content: { 'application/json': { schema: SubtitleOffsetSchema } } },
  },
  responses: {
    200: json('The stored offset', SubtitleOffsetSchema),
    ...offsetResponses,
  },
});

const clearSubtitleOffsetRoute = createRoute({
  method: 'delete',
  path: '/v1/sessions/{id}/subtitles/{fileId}/offset',
  operationId: 'clearSessionSubtitleOffset',
  summary: "Clear a subtitle track's session offset",
  description:
    'Same as setting `offsetMs` to 0. Clearing an offset that is not set changes nothing.',
  tags,
  security: BEARER_SECURITY,
  request: { params: SubtitleOffsetParams },
  responses: {
    204: { description: 'Cleared' },
    ...offsetResponses,
  },
});

/** Routes under `/v1/sessions/{id}` for tokens, viewers and subtitles. Client scope (mounted by the caller). */
export function registerMediaTokenRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const record = async (id: string, allowReleased: boolean) => {
    const found = await sessionService(deps).getRecord(id);
    if (found === undefined) throw new ProblemError(404, 'No session with this id.');
    if (!allowReleased && found.status === 'released') {
      throw new ProblemError(410, 'This session has been released.');
    }
    return found;
  };

  // Before `{subject}`'s routes: `revoke-all` is a fixed path.
  app.openapi(revokeAllRoute, async (c) => {
    const { id } = c.req.valid('param');
    await record(id, true);
    const tokenEpoch = await gatewayServices(deps).tokens.revokeAll(id);
    deps.logger.info({ reqId: c.get('requestId'), sessionId: id, tokenEpoch }, 'tokens revoked');
    return c.json({ tokenEpoch }, 200);
  });

  app.openapi(mintTokenRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const session = await record(id, false);
    const { tokens } = gatewayServices(deps);
    await tokens.start();
    const until = tokens.revokedUntil(id, body.subject);
    if (until !== undefined) {
      throw new ProblemError(
        409,
        `This subject is revoked on this session until ${new Date(until).toISOString()}; use another subject.`,
      );
    }
    const { media } = deps.config;
    const ttlMs = Math.min(
      body.ttl === undefined ? media.tokenTtlMs : body.ttl * 1000,
      media.tokenMaxTtlMs,
    );
    const minted = await tokens.mint(id, body.subject, session.tokenEpoch, ttlMs);
    const entry = session.delivery === 'transcode' ? 'master.m3u8' : 'stream';
    const mediaPath = `${MEDIA_PREFIX}/${minted.token}/${entry}`;
    const out: MediaToken = {
      token: minted.token,
      subject: body.subject,
      sessionId: id,
      mediaPath,
      exp: new Date(minted.expiresAt).toISOString(),
    };
    if (media.publicBase !== null) out.mediaUrl = `${media.publicBase}${mediaPath}`;
    deps.logger.info(
      { reqId: c.get('requestId'), sessionId: id, subject: body.subject, exp: out.exp },
      'media token minted',
    );
    return c.json(out, 201);
  });

  app.openapi(revokeSubjectRoute, async (c) => {
    const { id, subject } = c.req.valid('param');
    await record(id, true);
    await gatewayServices(deps).tokens.revokeSubject(id, subject);
    deps.logger.info({ reqId: c.get('requestId'), sessionId: id, subject }, 'subject revoked');
    return c.body(null, 204);
  });

  app.openapi(viewersRoute, async (c) => {
    const { id } = c.req.valid('param');
    await record(id, false);
    return c.json({ viewers: gatewayServices(deps).viewers.list(id) }, 200);
  });

  app.openapi(sessionSubtitlesRoute, async (c) => {
    const { id } = c.req.valid('param');
    const session = await record(id, false);
    const hints = await sessionService(deps).subtitleHints(session, c.req.raw.signal);
    return c.json(await gatewayServices(deps).subtitles.list(session.item, hints, id), 200);
  });

  /** The session and a check that `fileId` is one of its item's tracks. */
  const offsetTarget = async (id: string, fileId: string) => {
    const session = await record(id, false);
    if (!(await gatewayServices(deps).subtitles.has(session.item, fileId))) {
      throw new ProblemError(404, "No subtitle file with this id for this session's item.");
    }
  };

  app.openapi(setSubtitleOffsetRoute, async (c) => {
    const { id, fileId } = c.req.valid('param');
    await offsetTarget(id, fileId);
    const offsetMs = await gatewayServices(deps).subtitles.setOffset(
      id,
      fileId,
      c.req.valid('json').offsetMs,
    );
    deps.logger.info({ reqId: c.get('requestId'), sessionId: id, offsetMs }, 'subtitle offset set');
    return c.json({ offsetMs }, 200);
  });

  app.openapi(clearSubtitleOffsetRoute, async (c) => {
    const { id, fileId } = c.req.valid('param');
    await offsetTarget(id, fileId);
    await gatewayServices(deps).subtitles.setOffset(id, fileId, 0);
    deps.logger.info({ reqId: c.get('requestId'), sessionId: id }, 'subtitle offset cleared');
    return c.body(null, 204);
  });
}
