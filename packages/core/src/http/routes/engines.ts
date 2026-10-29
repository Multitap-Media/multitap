import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { ENGINE_ID_PATTERN, EngineDescriptorSchema, EngineInputSchema } from '@multitap/api';
import { deleteEngine, getEngineView, listEngineViews, putEngine } from '../../engines/index.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const IdParams = z.object({
  id: z
    .string()
    .regex(new RegExp(ENGINE_ID_PATTERN))
    .openapi({ param: { name: 'id', in: 'path' }, example: 'home' }),
});

const tags = ['admin: engines'];
const engineContent = { 'application/json': { schema: EngineDescriptorSchema } };

const listRoute = createRoute({
  method: 'get',
  path: '/v1/admin/engines',
  operationId: 'listEngines',
  summary: 'List engines',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'Every engine descriptor, by id',
      content: { 'application/json': { schema: z.array(EngineDescriptorSchema) } },
    },
    ...authResponses,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/admin/engines/{id}',
  operationId: 'getEngine',
  summary: 'Get an engine',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    200: { description: 'The engine', content: engineContent },
    ...validationResponse,
    ...authResponses,
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/v1/admin/engines/{id}',
  operationId: 'putEngine',
  summary: 'Create or replace an engine',
  description:
    "Creates the engine or replaces its descriptor. A changed address or transport resets the engine's health to unknown until the next health check. `proxyPassword` is write-only: omitted keeps the stored password, an empty string or null clears it, and responses show only `proxyPasswordSet`.",
  tags,
  security: BEARER_SECURITY,
  request: {
    params: IdParams,
    body: { required: true, content: { 'application/json': { schema: EngineInputSchema } } },
  },
  responses: {
    200: { description: 'The engine was replaced', content: engineContent },
    201: { description: 'The engine was created', content: engineContent },
    ...validationResponse,
    ...authResponses,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/engines/{id}',
  operationId: 'deleteEngine',
  summary: 'Delete an engine',
  description: 'The engine `MULTITAP_SELECTION_DEFAULT_ENGINE` names cannot be deleted.',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    204: { description: 'Deleted' },
    ...validationResponse,
    ...authResponses,
    409: problemContent('This is the default engine'),
  },
});

/** `/v1/admin/engines`. The caller mounts the admin-scope middleware. */
export function registerEngineRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(listRoute, async (c) =>
    c.json(await listEngineViews(deps.db, deps.engineHealth), 200),
  );

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    const engine = await getEngineView(deps.db, id, deps.engineHealth);
    if (engine === undefined) throw new ProblemError(404, 'No engine with this id.');
    return c.json(engine, 200);
  });

  app.openapi(putRoute, async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { created } = await putEngine(deps.db, id, input);
    const engine = await getEngineView(deps.db, id, deps.engineHealth);
    if (engine === undefined) throw new Error('engine vanished after write');
    // Whether the password changed, never the password (okf:architecture/secrets-classes-and-engine-password).
    const proxyPassword =
      input.proxyPassword === undefined
        ? 'kept'
        : input.proxyPassword === null || input.proxyPassword === ''
          ? 'cleared'
          : 'set';
    deps.logger.info(
      { engineId: id, created, proxyPasswordChange: proxyPassword, by: c.get('apiKey').id },
      created ? 'engine created' : 'engine replaced',
    );
    return created ? c.json(engine, 201) : c.json(engine, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    if (
      deps.config.selection.defaultEngine !== undefined &&
      id === deps.config.selection.defaultEngine
    ) {
      throw new ProblemError(409, 'This is the default engine; change the default first.');
    }
    if (!(await deleteEngine(deps.db, id))) throw new ProblemError(404, 'No engine with this id.');
    deps.logger.info({ engineId: id, by: c.get('apiKey').id }, 'engine deleted');
    return c.body(null, 204);
  });
}
