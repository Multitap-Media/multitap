import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  API_KEY_SCOPES,
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRecord,
} from '../../auth/keys.ts';
import type { AppDeps, AppEnv } from '../types.ts';
import { ProblemError } from '../problem.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';

const timestamp = z.iso.datetime().openapi({ example: '2026-09-27T12:00:00.000Z' });

export const ApiKeySchema = z
  .object({
    id: z.string().openapi({ example: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
    scope: z.enum(API_KEY_SCOPES),
    label: z.string(),
    createdAt: timestamp,
    lastUsed: timestamp.nullable().openapi({ description: 'Updated at most once a minute.' }),
    revokedAt: timestamp.nullable(),
  })
  .openapi('ApiKey');

export const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string().openapi({
    description: 'The key itself. Returned only here, once; Multitap stores only its hash.',
  }),
}).openapi('CreatedApiKey');

export const CreateApiKeySchema = z
  .object({
    scope: z.enum(API_KEY_SCOPES).openapi({ description: '`admin` implies `client`.' }),
    label: z.string().trim().min(1).max(100).openapi({ example: 'my-player' }),
  })
  .openapi('CreateApiKey');

const IdParams = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '0f8fad5b-d9cb-469f-a165-70867728950e',
    }),
});

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function toApi(record: ApiKeyRecord): z.infer<typeof ApiKeySchema> {
  return {
    id: record.id,
    scope: record.scope,
    label: record.label,
    createdAt: new Date(record.createdAt).toISOString(),
    lastUsed: iso(record.lastUsed),
    revokedAt: iso(record.revokedAt),
  };
}

const WhoamiSchema = ApiKeySchema.omit({ revokedAt: true }).openapi('Whoami', {
  description: 'The calling key, as `ApiKey` without `revokedAt` (it is not revoked).',
  example: {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    scope: 'client',
    label: 'my-player',
    createdAt: '2026-09-27T12:00:00.000Z',
    lastUsed: '2026-09-27T12:05:00.000Z',
  },
});

const whoamiRoute = createRoute({
  method: 'get',
  path: '/v1/whoami',
  operationId: 'whoami',
  summary: 'Identify the calling API key',
  description:
    'Which key made this request: its id, scope, label and timestamps, never the key or its hash. ' +
    'Any `client` or `admin` key may call it; a `metrics` key is limited to `/metrics` and gets 403.',
  tags: ['meta'],
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'The calling key',
      content: { 'application/json': { schema: WhoamiSchema } },
    },
    ...authResponses,
  },
});

const tags = ['admin: api keys'];

const listRoute = createRoute({
  method: 'get',
  path: '/v1/admin/api-keys',
  operationId: 'listApiKeys',
  summary: 'List API keys',
  description: 'Every key, including revoked ones. Never includes keys or their hashes.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'The keys, oldest first',
      content: { 'application/json': { schema: z.array(ApiKeySchema) } },
    },
    ...authResponses,
  },
});

const createKeyRoute = createRoute({
  method: 'post',
  path: '/v1/admin/api-keys',
  operationId: 'createApiKey',
  summary: 'Create an API key',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateApiKeySchema } } },
  },
  responses: {
    201: {
      description: 'The new key, shown once',
      content: { 'application/json': { schema: CreatedApiKeySchema } },
    },
    ...validationResponse,
    ...authResponses,
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/api-keys/{id}',
  operationId: 'revokeApiKey',
  summary: 'Revoke an API key',
  description:
    'Marks the key revoked; it stays listed. Idempotent: revoking a revoked key keeps its original `revokedAt`.',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    200: {
      description: 'The revoked key',
      content: { 'application/json': { schema: ApiKeySchema } },
    },
    ...validationResponse,
    ...authResponses,
  },
});

/**
 * `/v1/whoami` (any client or admin key, via the `/v1/*` middleware) and
 * `/v1/admin/api-keys` (the caller mounts the admin-scope middleware).
 */
export function registerApiKeyRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(whoamiRoute, async (c) => {
    const record = await getApiKey(deps.db, c.get('apiKey').id);
    // The key was verified moments ago; it can only be gone if revoked/deleted since.
    if (record?.revokedAt !== null) throw new ProblemError(404);
    const { id, scope, label, createdAt, lastUsed } = toApi(record);
    return c.json({ id, scope, label, createdAt, lastUsed }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const keys = await listApiKeys(deps.db);
    return c.json(keys.map(toApi), 200);
  });

  app.openapi(createKeyRoute, async (c) => {
    const input = c.req.valid('json');
    const created = await createApiKey(deps.db, input, deps.clock);
    deps.logger.info(
      { apiKeyId: created.id, scope: created.scope, by: c.get('apiKey').id },
      'api key created',
    );
    return c.json({ ...toApi(created), key: created.key }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const { id } = c.req.valid('param');
    const revoked = await revokeApiKey(deps.db, id, deps.clock);
    if (!revoked) throw new ProblemError(404, 'No API key with this id.');
    deps.logger.info({ apiKeyId: id, by: c.get('apiKey').id }, 'api key revoked');
    return c.json(toApi(revoked), 200);
  });
}
