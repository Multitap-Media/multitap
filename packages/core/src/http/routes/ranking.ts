/**
 * `/v1/admin/ranking` (okf:concept/ranking-settings): the ranking settings. `GET` shows
 * the effective values beside the defaults (a complete, shareable preset in
 * `effective`); `PATCH` changes some, `PUT` replaces all (imports a preset),
 * `DELETE` resets. Writes are validated whole, apply to the next source list,
 * and emit `settings.changed`.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  RankingSettingsInputSchema,
  RankingSettingsPatchSchema,
  RankingSettingsViewSchema,
} from '@multitap/api';
import {
  RankingSettingsError,
  type RankingSettingsStore,
} from '../../selection/ranking-settings.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { ProblemError } from '../problem.ts';
import { rankingStore } from '../selection-deps.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const PATH = '/v1/admin/ranking';
const tags = ['admin: ranking'];
const viewResponse = (description: string) => ({
  200: { description, content: { 'application/json': { schema: RankingSettingsViewSchema } } },
});

const getRoute = createRoute({
  method: 'get',
  path: PATH,
  operationId: 'getRankingSettings',
  summary: 'The ranking settings',
  description:
    'The effective settings, the built-in defaults, and the overrides an operator stored. ' +
    '`effective` is a complete preset that `PUT` accepts.',
  tags,
  security: BEARER_SECURITY,
  responses: { ...viewResponse('Effective, defaults and overrides'), ...authResponses },
});

const patchRoute = createRoute({
  method: 'patch',
  path: PATH,
  operationId: 'patchRankingSettings',
  summary: 'Change some ranking settings',
  description:
    'Merged over the effective settings. Unknown fields and out-of-range values are rejected and ' +
    'nothing is stored. A value set back to its default stops being an override.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RankingSettingsPatchSchema } },
    },
  },
  responses: { ...viewResponse('The new settings'), ...validationResponse, ...authResponses },
});

const putRoute = createRoute({
  method: 'put',
  path: PATH,
  operationId: 'putRankingSettings',
  summary: 'Replace the ranking settings',
  description:
    'A complete document (for example another Multitap instance’s `effective`). Only the values that differ ' +
    'from the defaults are stored. Groups added later (`binge`, `lastSource`) may be left out, so an ' +
    'older preset still imports; they take the defaults.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RankingSettingsInputSchema } },
    },
  },
  responses: { ...viewResponse('The new settings'), ...validationResponse, ...authResponses },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: PATH,
  operationId: 'resetRankingSettings',
  summary: 'Reset the ranking settings to the defaults',
  tags,
  security: BEARER_SECURITY,
  responses: { ...viewResponse('The defaults, now effective'), ...authResponses },
});

/** `/v1/admin/ranking`. The caller mounts the admin-scope middleware. */
export function registerRankingRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const store = (): RankingSettingsStore => rankingStore(deps);
  const logged = (keyId: string, action: string) => {
    deps.logger.info({ by: keyId, key: 'ranking' }, `ranking settings ${action}`);
  };

  app.openapi(getRoute, async (c) => c.json(await store().view(), 200));

  // Body validation happens in the route schemas; this catches whole-document checks.
  const invalid = (err: RankingSettingsError) =>
    new ProblemError(
      400,
      `${err.message} ${err.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );

  app.openapi(patchRoute, async (c) => {
    try {
      const view = await store().patch(c.req.valid('json'));
      logged(c.get('apiKey').id, 'changed');
      return c.json(view, 200);
    } catch (err) {
      if (err instanceof RankingSettingsError) throw invalid(err);
      throw err;
    }
  });

  app.openapi(putRoute, async (c) => {
    try {
      const view = await store().replace(c.req.valid('json'));
      logged(c.get('apiKey').id, 'replaced');
      return c.json(view, 200);
    } catch (err) {
      if (err instanceof RankingSettingsError) throw invalid(err);
      throw err;
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const view = await store().reset();
    logged(c.get('apiKey').id, 'reset');
    return c.json(view, 200);
  });
}
