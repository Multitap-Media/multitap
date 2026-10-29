import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { matchedRoutes } from 'hono/route';
import { requireScope } from '../auth/middleware.ts';
import { isDatabaseReachable } from '../db/index.ts';
import { allowlistCors } from './cors.ts';
import {
  BEARER_SCHEME,
  BEARER_SCHEME_OBJECT,
  BEARER_SECURITY,
  DOCUMENT_INFO,
  authResponses,
} from './openapi.ts';
import { notFoundResponse, problemContent, problemResponse, ProblemError } from './problem.ts';
import { registerAddonRoutes } from './routes/addons.ts';
import { registerApiKeyRoutes } from './routes/api-keys.ts';
import { registerBackupRoutes } from './routes/backups.ts';
import { registerBrowseRoutes } from './routes/browse.ts';
import { registerDevRoutes } from './routes/dev.ts';
import { registerEngineRoutes } from './routes/engines.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerMediaTokenRoutes } from './routes/media-tokens.ts';
import { registerMetricsRoute } from './routes/metrics.ts';
import { registerProfileRoutes } from './routes/profiles.ts';
import { registerRankingRoutes } from './routes/ranking.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import type { AppDeps, AppEnv } from './types.ts';

export type { AppDeps, AppEnv } from './types.ts';

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  operationId: 'health',
  summary: 'Liveness and database reachability',
  description: 'No authentication. For container health checks.',
  tags: ['health'],
  responses: {
    200: {
      description: 'Multitap is up and its database answers',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok') }).openapi('Health'),
        },
      },
    },
    503: problemContent('The database is unreachable'),
  },
});

const DOCUMENT_PATH = '/openapi.json';

/**
 * Request headers a cross-origin `/v1` caller may send. `Last-Event-ID` lets a
 * fetch-based SSE client resume `/v1/events` (okf:architecture/core-events-sse).
 */
const API_CORS_HEADERS = ['Authorization', 'Content-Type', 'Last-Event-ID'];

/** The route pattern that answered, never the raw path or query (they can carry secrets). */
function routeOf(c: Context): string {
  const handled = matchedRoutes(c).findLast((route) => route.method !== 'ALL');
  return handled?.path ?? '(unmatched)';
}

/**
 * The methods each documented path answers (GET implies HEAD), as a lookup
 * from a request path to its methods, each mapped to whether it requires a
 * request body. As in OpenAPI, a concrete path wins over templated ones:
 * `/v1/admin/addons/order` is not `/v1/admin/addons/{id}`; among templated
 * paths, those with the fewest parameters win, so
 * `/v1/sessions/{id}/tokens/revoke-all` is not `…/tokens/{subject}`. Undocumented routes
 * (such as `/dev`) are left out, so they never reveal themselves with a 405.
 */
function documentedMethods(
  app: OpenAPIHono<AppEnv>,
): (path: string) => Map<string, boolean> | undefined {
  const byPath = new Map<string, Map<string, boolean>>();
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== 'route') continue;
    const methods = byPath.get(def.route.path) ?? new Map<string, boolean>();
    const body = def.route.request?.body;
    methods.set(
      def.route.method.toUpperCase(),
      body !== undefined && !('$ref' in body) && body.required === true,
    );
    if (def.route.method === 'get') methods.set('HEAD', false);
    byPath.set(def.route.path, methods);
  }
  const templated = [...byPath]
    .filter(([path]) => path.includes('{'))
    .map(([path, methods]) => ({
      pattern: new RegExp(
        `^${path
          .split(/\{[^}]+\}/)
          .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
          .join('[^/]+')}$`,
      ),
      params: path.split('{').length - 1,
      methods,
    }));
  return (path) => {
    const concrete = byPath.get(path);
    if (concrete !== undefined && !path.includes('{')) return concrete;
    const matches = templated.filter((entry) => entry.pattern.test(path));
    if (matches.length === 0) return undefined;
    const fewest = Math.min(...matches.map((entry) => entry.params));
    return new Map(
      matches.filter((entry) => entry.params === fewest).flatMap((entry) => [...entry.methods]),
    );
  };
}

/**
 * Builds Multitap's HTTP app. Deps are only touched while serving requests, so the
 * app can also be built just to read its OpenAPI document ({@link openApiDocument}).
 */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    // Request validation failures from any route's zod schemas.
    defaultHook: (result, c) => {
      if (result.success) return;
      return problemResponse(c, 400, {
        detail: 'The request failed validation.',
        errors: result.error.issues.map((issue) => ({
          in: result.target,
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    },
  });

  app.openAPIRegistry.registerComponent('securitySchemes', BEARER_SCHEME, BEARER_SCHEME_OBJECT);

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - start) * 10) / 10;
    const method = c.req.method;
    const status = c.res.status;
    const route = routeOf(c);
    deps.metrics.recordHttpRequest(method, status, durationMs);
    deps.logger.info(
      {
        reqId: c.get('requestId'),
        method,
        route,
        status,
        durationMs,
      },
      'request',
    );
  });

  let methodsFor: ReturnType<typeof documentedMethods> | undefined;
  const documented = (path: string) => (methodsFor ??= documentedMethods(app))(path);

  // CORS from MULTITAP_CORS_ORIGINS (okf:architecture/core-deployment), before auth: preflights carry no
  // key. A preflight answers with the path's documented methods; one for an
  // undocumented path gets no CORS headers and falls through to the 404.
  let corsHandler: MiddlewareHandler | undefined;
  app.use((c, next) => {
    corsHandler ??= allowlistCors(deps.config.corsOrigins, {
      allowMethods: (ctx) => {
        const methods = documented(ctx.req.path);
        return methods === undefined ? undefined : [...methods.keys()].sort();
      },
      allowHeaders: API_CORS_HEADERS,
    });
    return corsHandler(c, next);
  });

  app.notFound((c) => notFoundResponse(c));
  app.onError((err, c) => {
    if (err instanceof ProblemError) {
      return problemResponse(
        c,
        err.status,
        err.detail === undefined ? {} : { detail: err.detail },
        err.headers,
      );
    }
    if (err instanceof HTTPException && err.status < 500) {
      // e.g. malformed JSON bodies, rejected by the validator before the hook runs.
      return problemResponse(c, err.status, { detail: err.message });
    }
    deps.logger.error({ reqId: c.get('requestId'), err }, 'unhandled error');
    return problemResponse(c, 500);
  });

  // Auth. Anything under /v1 needs a key; /v1/admin needs the admin scope.
  const client = requireScope('client', deps);
  app.use('/v1/*', client);
  app.use('/v1/admin/*', requireScope('admin', deps));
  app.use(DOCUMENT_PATH, client);
  app.use('/metrics', requireScope('metrics', deps));

  // A documented path asked with a method it doesn't have is a 405 with
  // `Allow`, after auth (so without a key it's still a 404) and before routing
  // (so `PATCH /v1/admin/addons/order` doesn't reach `PATCH …/{id}`). A route
  // whose body is required gets a 400 without a JSON body.
  app.use(async (c, next) => {
    const methods = documented(c.req.path);
    const requiresBody = methods?.get(c.req.method);
    if (methods === undefined || requiresBody === false) {
      await next();
      return;
    }
    if (requiresBody === true) {
      // Hono's validator reads a body without a JSON Content-Type as `{}`,
      // which an all-optional schema (a PATCH) would accept.
      if (!/^application\/json(;|$)/i.test(c.req.header('Content-Type') ?? '')) {
        return problemResponse(c, 400, {
          detail: 'This route needs a JSON body (Content-Type: application/json).',
        });
      }
      await next();
      return;
    }
    const allow = [...methods.keys()].sort().join(', ');
    c.header('Allow', allow);
    return problemResponse(c, 405, { detail: `This route answers ${allow}.` });
  });

  app.openapi(healthRoute, async (c) => {
    if (!(await isDatabaseReachable(deps.db))) {
      throw new ProblemError(503, 'The database is unreachable.');
    }
    return c.json({ status: 'ok' as const }, 200);
  });

  registerApiKeyRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerAddonRoutes(app, deps);
  registerEngineRoutes(app, deps);
  registerRankingRoutes(app, deps);
  registerBrowseRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerMediaTokenRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMetricsRoute(app, deps);
  // Not in the OpenAPI document; 404 unless NODE_ENV=development.
  registerDevRoutes(app, deps);

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: DOCUMENT_PATH,
    operationId: 'openApiDocument',
    summary: 'This OpenAPI document',
    tags: ['meta'],
    security: BEARER_SECURITY,
    responses: {
      200: {
        description: 'The OpenAPI 3.1 document',
        content: { 'application/json': { schema: z.object({}).loose() } },
      },
      ...authResponses,
    },
  });
  app.get(DOCUMENT_PATH, (c) => c.json(documentOf(app)));

  return app;
}

function documentOf(app: OpenAPIHono<AppEnv>) {
  return app.getOpenAPI31Document(DOCUMENT_INFO);
}

/** Deps for building the app only to read its document; any use is a bug. */
const documentOnlyDeps = new Proxy({} as AppDeps, {
  get(_target, prop) {
    throw new Error(`openApiDocument(): app deps are not available (${String(prop)})`);
  },
});

/**
 * Multitap's OpenAPI 3.1 document, generated from the route definitions without a
 * database or a server. Step 8 writes it to packages/api/openapi.json.
 */
export function openApiDocument(): ReturnType<OpenAPIHono['getOpenAPI31Document']> {
  return documentOf(createApp(documentOnlyDeps));
}
