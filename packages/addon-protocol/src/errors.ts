/**
 * Errors thrown by the addon HTTP client.
 *
 * Addon URLs can carry secrets (a debrid key in the path, a token in the query),
 * so no message or property holds a full URL: only its `host`. Response bodies
 * are never included either.
 */
import type { z } from 'zod';

export type AddonErrorCode =
  | 'invalid-url'
  | 'unsupported-transport'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http-status'
  | 'too-large'
  | 'invalid-json'
  | 'validation';

export abstract class AddonError extends Error {
  abstract readonly code: AddonErrorCode;
  /** The addon's host (`hostname[:port]`), or `undefined` if the URL didn't parse. */
  readonly host: string | undefined;

  constructor(message: string, host: string | undefined) {
    super(message);
    this.name = new.target.name;
    this.host = host;
  }
}

function describe(host: string | undefined): string {
  return host === undefined ? 'addon' : `addon at ${host}`;
}

/** The URL didn't parse, or its scheme isn't http(s). */
export class AddonInvalidUrlError extends AddonError {
  readonly code = 'invalid-url';
  constructor(host?: string) {
    super(
      host === undefined
        ? 'Invalid addon URL'
        : `Invalid addon URL for ${host}: only http and https are supported`,
      host,
    );
  }
}

/**
 * The transport URL's path doesn't end in `/manifest.json`. That includes the
 * legacy `/stremio/v1` transport, which isn't supported.
 */
export class AddonUnsupportedTransportError extends AddonError {
  readonly code = 'unsupported-transport';
  constructor(host: string) {
    super(
      `Unsupported transport for ${describe(host)}: the URL must end in /manifest.json (legacy addons are not supported)`,
      host,
    );
  }
}

/** The request failed before a response arrived (DNS, connection refused, reset, …). */
export class AddonNetworkError extends AddonError {
  readonly code = 'network';
  /** A system error code such as `ECONNREFUSED`, when one was available. */
  readonly causeCode: string | undefined;
  constructor(host: string, causeCode?: string) {
    super(
      `Request to ${describe(host)} failed${causeCode === undefined ? '' : ` (${causeCode})`}`,
      host,
    );
    this.causeCode = causeCode;
  }
}

export class AddonTimeoutError extends AddonError {
  readonly code = 'timeout';
  readonly timeoutMs: number;
  constructor(host: string, timeoutMs: number) {
    super(`Request to ${describe(host)} timed out after ${String(timeoutMs)} ms`, host);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's `AbortSignal` fired. */
export class AddonAbortedError extends AddonError {
  readonly code = 'aborted';
  constructor(host: string) {
    super(`Request to ${describe(host)} was aborted`, host);
  }
}

export class AddonHttpStatusError extends AddonError {
  readonly code = 'http-status';
  readonly status: number;
  constructor(host: string, status: number) {
    super(`Request to ${describe(host)} failed with HTTP ${String(status)}`, host);
    this.status = status;
  }
}

export class AddonResponseTooLargeError extends AddonError {
  readonly code = 'too-large';
  readonly maxBytes: number;
  constructor(host: string, maxBytes: number) {
    super(`Response from ${describe(host)} exceeded ${String(maxBytes)} bytes`, host);
    this.maxBytes = maxBytes;
  }
}

export class AddonInvalidJsonError extends AddonError {
  readonly code = 'invalid-json';
  constructor(host: string) {
    super(`Response from ${describe(host)} is not valid JSON`, host);
  }
}

/** The body is JSON but not the expected shape. Item-level failures in lists don't throw. */
export class AddonValidationError extends AddonError {
  readonly code = 'validation';
  readonly issues: z.core.$ZodIssue[];
  constructor(host: string, detail: string, issues: z.core.$ZodIssue[] = []) {
    super(`Invalid response from ${describe(host)}: ${detail}`, host);
    this.issues = issues;
  }
}
