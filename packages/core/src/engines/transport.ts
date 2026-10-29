/**
 * How Multitap reaches an engine (okf:architecture/engine-transport-and-health). Nothing above the transport
 * cares which one is in use. Phase 2 implements `lan` (plain HTTP to the
 * engine's `address`); `tunnel` is phase 5 (okf:architecture/future-remote-engines).
 *
 * Contract for every implementation:
 * - `path` is the engine path with its query (`/hlsv2/probe?mediaURL=…`),
 *   always starting with `/`; the transport adds the base.
 * - No `Origin` header is ever sent (server-go's origin allowlist, okf:architecture/engine-security-posture).
 * - `timeoutMs` bounds the whole exchange up to the response headers; the
 *   body is the caller's to consume or cancel. `signal` aborts early.
 * - A network failure or timeout rejects with {@link EngineTransportError};
 *   any HTTP status resolves (the caller interprets 4xx/5xx).
 * - Request and response URLs can carry `mediaURL`s (secrets): implementations
 *   never log them at `info` and above.
 */

export interface EngineRequestInit {
  method?: 'GET' | 'HEAD' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON-encoded by the caller. */
  body?: string;
  /** Time until response headers, in milliseconds. Required: every engine call has a budget. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EngineTransport {
  readonly kind: 'lan' | 'tunnel';
  request(path: string, init: EngineRequestInit): Promise<Response>;
}

export type EngineTransportErrorCode = 'timeout' | 'network' | 'aborted';

/** A request that got no HTTP response. Never carries the URL (it may hold secrets). */
export class EngineTransportError extends Error {
  override name = 'EngineTransportError';
  readonly code: EngineTransportErrorCode;
  readonly engineId: string;

  constructor(engineId: string, code: EngineTransportErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.engineId = engineId;
    this.code = code;
  }
}

/** Builds the transport for an engine descriptor's `transport` and `address`. */
export type EngineTransportFactory = (engine: {
  id: string;
  transport: 'lan' | 'tunnel';
  address: string | null;
}) => EngineTransport;
