import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { AddAddonSchema, AddonSchema, ReorderAddonsSchema, UpdateAddonSchema } from '@multitap/api';
import { AddonCollectionError, addonView, type AddonRecord } from '../../addons/index.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['admin: addons'];

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

const addonContent = (description: string) => ({
  description,
  content: { 'application/json': { schema: AddonSchema } },
});
const addonListContent = (description: string) => ({
  description,
  content: { 'application/json': { schema: z.array(AddonSchema) } },
});
const notFound = {
  404: problemContent('No addon with this id, or the API key is missing, invalid or revoked'),
};

const listRoute = createRoute({
  method: 'get',
  path: '/v1/admin/addons',
  operationId: 'listAddons',
  summary: 'List installed addons',
  description: 'In collection order. Manifest URLs are secret and never included.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: addonListContent('The addons, in collection order'),
    ...authResponses,
  },
});

const addRoute = createRoute({
  method: 'post',
  path: '/v1/admin/addons',
  operationId: 'addAddon',
  summary: 'Install an addon by manifest URL',
  description:
    'Fetches and validates the manifest, then appends the addon to the collection, enabled. ' +
    'The URL must end in `/manifest.json` (legacy addons are not supported). ' +
    'An addon whose manifest says `configurationRequired` is installed but not queried (`state: needs-configuration`).',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: AddAddonSchema } } },
  },
  responses: {
    201: addonContent('The installed addon'),
    400: problemContent(
      'The request failed validation, the URL is invalid or legacy, or its manifest could not be fetched or is invalid',
    ),
    ...authResponses,
    409: problemContent('An addon with this manifest URL is already installed'),
  },
});

const previewRoute = createRoute({
  method: 'post',
  path: '/v1/admin/addons/preview',
  operationId: 'previewAddon',
  summary: 'Preview an addon by manifest URL',
  description:
    'Fetches and validates the manifest like an install does, and returns the addon as it would be ' +
    'installed, without storing it. `id` is empty unless the manifest URL is already installed ' +
    '(then it is the id of that addon). The URL is secret: never returned or logged.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: AddAddonSchema } } },
  },
  responses: {
    200: addonContent('The addon the manifest describes, not stored'),
    400: problemContent(
      'The request failed validation, the URL is invalid or legacy, or its manifest could not be fetched or is invalid',
    ),
    ...authResponses,
  },
});

const reorderRoute = createRoute({
  method: 'put',
  path: '/v1/admin/addons/order',
  operationId: 'reorderAddons',
  summary: 'Set the collection order',
  description: 'Addons are asked, and their results listed, in this order.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: ReorderAddonsSchema } } },
  },
  responses: {
    200: addonListContent('The addons in their new order'),
    ...validationResponse,
    ...authResponses,
    409: problemContent('The ids are not exactly the installed addons, each once'),
  },
});

const refreshAllRoute = createRoute({
  method: 'post',
  path: '/v1/admin/addons/refresh',
  operationId: 'refreshAddons',
  summary: 'Refetch every manifest',
  description:
    'An addon whose manifest fails to fetch keeps its last good one and reports `refreshError`.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: addonListContent('The addons after the refresh'),
    ...authResponses,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/v1/admin/addons/{id}',
  operationId: 'updateAddon',
  summary: 'Enable or disable an addon',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: IdParams,
    body: { required: true, content: { 'application/json': { schema: UpdateAddonSchema } } },
  },
  responses: {
    200: addonContent('The updated addon'),
    ...validationResponse,
    ...authResponses,
    ...notFound,
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/v1/admin/addons/{id}/refresh',
  operationId: 'refreshAddon',
  summary: "Refetch one addon's manifest",
  description: 'On failure the last good manifest is kept and `refreshError` is set.',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    200: addonContent('The addon after the refresh'),
    ...validationResponse,
    ...authResponses,
    ...notFound,
  },
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/addons/{id}',
  operationId: 'removeAddon',
  summary: 'Uninstall an addon',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    204: { description: 'Removed' },
    ...validationResponse,
    ...authResponses,
    ...notFound,
  },
});

const STATUS = {
  'not-found': 404,
  duplicate: 409,
  'invalid-url': 400,
  'unsupported-transport': 400,
  'manifest-unavailable': 400,
  'order-mismatch': 409,
} as const;

/** Runs a collection operation, turning its errors into problems. */
async function guarded<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof AddonCollectionError) throw new ProblemError(STATUS[err.kind], err.message);
    throw err;
  }
}

const views = (records: readonly AddonRecord[]) => records.map(addonView);

/** `/v1/admin/addons`. The caller mounts the admin-scope middleware. */
export function registerAddonRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(listRoute, async (c) => {
    return c.json(views(await deps.addons.collection.list()), 200);
  });

  app.openapi(addRoute, async (c) => {
    const { manifestUrl } = c.req.valid('json');
    const record = await guarded(() => deps.addons.collection.add(manifestUrl));
    return c.json(addonView(record), 201);
  });

  app.openapi(previewRoute, async (c) => {
    const { manifestUrl } = c.req.valid('json');
    const record = await guarded(() => deps.addons.collection.preview(manifestUrl));
    return c.json(addonView(record), 200);
  });

  app.openapi(reorderRoute, async (c) => {
    const { ids } = c.req.valid('json');
    return c.json(views(await guarded(() => deps.addons.collection.reorder(ids))), 200);
  });

  app.openapi(refreshAllRoute, async (c) => {
    return c.json(views(await deps.addons.collection.refreshAll()), 200);
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    const record = await guarded(async () => {
      if (enabled !== undefined) return deps.addons.collection.setEnabled(id, enabled);
      const found = await deps.addons.collection.get(id);
      if (found === undefined) throw new ProblemError(404, 'No addon with this id.');
      return found;
    });
    return c.json(addonView(record), 200);
  });

  app.openapi(refreshRoute, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(addonView(await guarded(() => deps.addons.collection.refresh(id))), 200);
  });

  app.openapi(removeRoute, async (c) => {
    const { id } = c.req.valid('param');
    await guarded(() => deps.addons.collection.remove(id));
    return c.body(null, 204);
  });
}
