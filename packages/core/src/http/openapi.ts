import { MULTITAP_VERSION } from '../version.ts';
import { problemContent } from './problem.ts';

/** Name of the Bearer security scheme in the document. */
export const BEARER_SCHEME = 'bearerAuth';

/** `security` for routes that need an API key. */
export const BEARER_SECURITY = [{ [BEARER_SCHEME]: [] }];

export const BEARER_SCHEME_OBJECT = {
  type: 'http',
  scheme: 'bearer',
  description:
    'An API key created with `multitap api-key create` or `POST /v1/admin/api-keys`. ' +
    'A missing or invalid key gets 404, like an unknown route.',
} as const;

/** The auth outcomes every authenticated route can return (okf:architecture/core-api-keys-security). */
export const authResponses = {
  403: problemContent('The key is valid but lacks the scope this route needs'),
  404: problemContent('Not found, or the API key is missing, invalid or revoked'),
} as const;

export const validationResponse = {
  400: problemContent('The request failed validation'),
} as const;

export const DOCUMENT_INFO = {
  openapi: '3.1.0',
  info: {
    title: 'Multitap API',
    version: MULTITAP_VERSION,
    description:
      'Multitap: a headless Stremio client with a remote engine. ' +
      'Errors are RFC 9457 problem details. ' +
      'CORS: for an `Origin` in `MULTITAP_CORS_ORIGINS`, every response carries ' +
      '`Access-Control-Allow-Origin` with that origin and `Vary: Origin`, and an `OPTIONS` ' +
      'preflight to a documented path answers `204` with its methods and the ' +
      '`Authorization`, `Content-Type` and `Last-Event-ID` headers, without a key. ' +
      'No credentials mode. Other origins get no CORS headers (and `OPTIONS` gets `405`).',
  },
} as const;
