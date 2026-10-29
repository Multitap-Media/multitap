import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** RFC 9457 problem details. Every error Multitap returns has this shape. */
export const ProblemSchema = z
  .object({
    type: z.string().openapi({ example: 'about:blank' }),
    title: z.string().openapi({ example: 'Not Found' }),
    status: z.number().int().openapi({ example: 404 }),
    detail: z.string().optional(),
    errors: z
      .array(
        z.object({
          in: z.string().openapi({ description: 'Request part: param, query, json, header' }),
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional()
      .openapi({ description: 'Validation failures (400 only).' }),
  })
  .openapi('Problem');

export type Problem = z.infer<typeof ProblemSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TITLES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function problemBody(
  status: ContentfulStatusCode,
  extra: Partial<Omit<Problem, 'status'>> = {},
): Problem {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    ...extra,
  };
}

export function problemResponse(
  c: Context,
  status: ContentfulStatusCode,
  extra?: Partial<Omit<Problem, 'status'>>,
  headers?: Record<string, string>,
): Response {
  return c.body(JSON.stringify(problemBody(status, extra)), status, {
    ...headers,
    'Content-Type': PROBLEM_CONTENT_TYPE,
  });
}

/**
 * The response for an unknown route, and for any request to an authenticated
 * route without a valid key (okf:architecture/core-api-keys-security): the two must be indistinguishable.
 */
export function notFoundResponse(c: Context): Response {
  return problemResponse(c, 404);
}

/** Thrown by handlers to answer with a problem; rendered by the app's error handler. */
export class ProblemError extends Error {
  override name = 'ProblemError';
  readonly status: ContentfulStatusCode;
  readonly detail: string | undefined;
  /** Extra response headers, e.g. `Retry-After` on a `503`. */
  readonly headers: Record<string, string> | undefined;

  constructor(status: ContentfulStatusCode, detail?: string, headers?: Record<string, string>) {
    super(detail ?? TITLES[status] ?? `HTTP ${String(status)}`);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** OpenAPI response entry for a problem. */
export function problemContent(description: string) {
  return {
    description,
    content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } },
  } as const;
}
