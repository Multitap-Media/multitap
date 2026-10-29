/**
 * The `lan` engine transport (okf:architecture/engine-transport-and-health): plain HTTP(S) from Multitap to
 * the engine's `address`. Implements the {@link EngineTransport} contract:
 * per-call timeouts up to the response headers, no `Origin` header, no
 * redirects followed, and errors that never carry the URL (it can hold a
 * `mediaURL`, which is a secret).
 *
 * A connect timeout (`MULTITAP_ENGINE_CONNECT_TIMEOUT_MS`, okf:architecture/engine-transport-and-health) through an undici
 * dispatcher: a stopped engine host's firewall drops connections to the closed
 * port, and undici's default 10 s connect timeout made every request wait
 * that long. Node's bundled undici doesn't export its `Agent`, so the
 * `undici` package (the version Node 26 bundles) provides it; the global
 * `fetch` is still used, and accepts the `dispatcher`. The per-call timeouts
 * still bound the whole exchange.
 */
import { Agent } from 'undici';
import {
  EngineTransportError,
  type EngineRequestInit,
  type EngineTransport,
  type EngineTransportFactory,
} from './transport.ts';

export interface LanTransportOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** TCP (and TLS) connect timeout; undefined keeps undici's default (10 s). */
  connectTimeoutMs?: number;
}

const dispatchers = new Map<number, Agent>();

/**
 * The dispatcher for a connect timeout, one per value for the process, so
 * every engine client with the same setting shares one connection pool.
 */
export function lanDispatcher(connectTimeoutMs: number): Agent {
  let agent = dispatchers.get(connectTimeoutMs);
  if (agent === undefined) {
    agent = new Agent({ connect: { timeout: connectTimeoutMs } });
    dispatchers.set(connectTimeoutMs, agent);
  }
  return agent;
}

/** The base URL of an engine address: http(s) only, no trailing slash, no query. */
export function engineBaseUrl(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('engine address is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('engine address must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('engine address must not carry credentials');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function createLanTransport(
  engine: { id: string; address: string | null },
  options: LanTransportOptions = {},
): EngineTransport {
  const doFetch = options.fetch ?? fetch;
  const dispatcher =
    options.connectTimeoutMs === undefined ? undefined : lanDispatcher(options.connectTimeoutMs);
  let base: string | undefined;
  let baseError: string | undefined;
  if (engine.address === null) {
    baseError = 'engine has no address';
  } else {
    try {
      base = engineBaseUrl(engine.address);
    } catch (err) {
      baseError = (err as Error).message;
    }
  }

  return {
    kind: 'lan',
    async request(path: string, init: EngineRequestInit): Promise<Response> {
      if (!path.startsWith('/')) throw new Error('engine path must start with "/"');
      if (base === undefined) {
        throw new EngineTransportError(engine.id, 'network', baseError ?? 'engine has no address');
      }
      if (init.signal?.aborted === true) {
        throw new EngineTransportError(engine.id, 'aborted', 'engine request aborted');
      }

      const headers = new Headers(init.headers);
      // server-go answers 403 to a disallowed Origin (okf:architecture/engine-security-posture); Multitap never sends one.
      headers.delete('origin');

      const controller = new AbortController();
      const timeout = { fired: false };
      const timer = setTimeout(() => {
        timeout.fired = true;
        controller.abort();
      }, init.timeoutMs);
      // The caller's signal keeps aborting the body after the headers arrive.
      const onAbort = () => {
        controller.abort();
      };
      init.signal?.addEventListener('abort', onAbort, { once: true });

      const requestInit: RequestInit & { dispatcher?: Agent } = {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
        redirect: 'manual',
        // Engines are private services: no cookies or cache semantics.
        credentials: 'omit',
        cache: 'no-store',
      };
      // A connect timeout fails like a refused connection: `network` below.
      if (dispatcher !== undefined) requestInit.dispatcher = dispatcher;
      try {
        return await doFetch(base + path, requestInit);
      } catch (err) {
        init.signal?.removeEventListener('abort', onAbort);
        if (timeout.fired) {
          throw new EngineTransportError(
            engine.id,
            'timeout',
            `engine did not answer within ${String(init.timeoutMs)} ms`,
          );
        }
        if (callerAborted(init.signal)) {
          throw new EngineTransportError(engine.id, 'aborted', 'engine request aborted');
        }
        // The cause is kept for `err` serialisation; fetch errors name the host, never the path.
        throw new EngineTransportError(engine.id, 'network', 'engine unreachable', causeOf(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A function, so TypeScript doesn't keep the narrowing from before the await. */
function callerAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Undici wraps the useful error (ECONNREFUSED, …) in `cause`; drop the outer one. */
function causeOf(err: unknown): unknown {
  if (err instanceof Error && err.cause !== undefined) {
    const cause = err.cause as { code?: unknown; message?: unknown };
    return { code: cause.code, message: typeof cause.message === 'string' ? cause.message : '' };
  }
  return undefined;
}

/**
 * The transport factory Multitap uses: `lan` descriptors get a {@link createLanTransport};
 * `tunnel` is phase 5 and fails every request as unreachable.
 */
export function createTransportFactory(options: LanTransportOptions = {}): EngineTransportFactory {
  return (engine) => {
    if (engine.transport === 'lan') return createLanTransport(engine, options);
    return {
      kind: 'tunnel',
      request() {
        return Promise.reject(
          new EngineTransportError(engine.id, 'network', 'the tunnel transport is not built yet'),
        );
      },
    };
  };
}
