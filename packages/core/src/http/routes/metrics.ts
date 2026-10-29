import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { BEARER_SECURITY, authResponses } from '../openapi.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['metrics'];

const metricsRoute = createRoute({
  method: 'get',
  path: '/metrics',
  operationId: 'metrics',
  summary: 'Prometheus metrics',
  description:
    'Multitap metrics in Prometheus text format. Requires `metrics` scope; `admin` also grants it.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'Prometheus format metrics',
      content: { 'text/plain': { schema: z.string() } },
    },
    ...authResponses,
  },
});

/** `/metrics`: Prometheus metrics. The caller mounts the metrics-scope middleware. */
export function registerMetricsRoute(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(metricsRoute, async (c) => {
    const metricsText = await deps.metrics.metrics();
    return c.text(metricsText, 200);
  });
}
