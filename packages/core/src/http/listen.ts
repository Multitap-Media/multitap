import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIPv4, type AddressInfo } from 'node:net';
import { createSecureContext } from 'node:tls';
import { serve, type ServerType } from '@hono/node-server';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';

type TlsFiles = NonNullable<Config['tls']>;

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

/**
 * Reads the certificate and key and checks they form a usable context (the
 * key matches the certificate).
 *
 * @throws when a file can't be read or the pair is invalid.
 */
export function readTlsMaterial(files: TlsFiles): TlsMaterial {
  const material = { cert: readFileSync(files.certFile), key: readFileSync(files.keyFile) };
  createSecureContext(material);
  return material;
}

/**
 * How long {@link Listener.close} lets open requests finish before cutting
 * them: well inside the 10 s shutdown limit, so the library is still flushed.
 */
export const CLOSE_GRACE_MS = 5_000;
const IDLE_SWEEP_MS = 50;

export interface Listener {
  server: ServerType;
  /** The bound port (`0` in config picks a free one). */
  port: number;
  /**
   * Stops accepting connections and resolves once open ones have finished.
   * Connections still open after `graceMs` (a long media response) are cut.
   */
  close(graceMs?: number): Promise<void>;
}

/**
 * Serves `fetch` on `port`, over HTTPS (`node:https` through
 * `@hono/node-server`) when `tls` is given, else plain HTTP. `hostname`
 * (`MULTITAP_API_BIND`/`MULTITAP_MEDIA_BIND`) is the address to bind; null or omitted binds all
 * interfaces, Node's default.
 */
export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  tls: TlsMaterial | null,
  hostname: string | null = null,
): Promise<Listener> {
  const bind = hostname === null ? {} : { hostname };
  const server =
    tls === null
      ? serve({ fetch, port, ...bind })
      : serve({
          fetch,
          port,
          ...bind,
          createServer: createHttpsServer,
          serverOptions: { ...tls },
        });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close(graceMs = CLOSE_GRACE_MS) {
      closing ??= new Promise<void>((resolve) => {
        const cut = setTimeout(() => {
          if ('closeAllConnections' in server) server.closeAllConnections();
        }, graceMs);
        // Keep-alive connections would otherwise hold close() open, including
        // those whose response ends after close() began (an event stream
        // ending on shutdown), so idle ones are closed until none are left.
        const idle = setInterval(() => {
          if ('closeIdleConnections' in server) server.closeIdleConnections();
        }, IDLE_SWEEP_MS);
        cut.unref();
        idle.unref();
        server.close(() => {
          clearTimeout(cut);
          clearInterval(idle);
          resolve();
        });
        if ('closeIdleConnections' in server) server.closeIdleConnections();
      });
      return closing;
    },
  };
}

/**
 * Whether a listener's bound address is reachable from this host only:
 * `127.0.0.0/8`, `::1` or an IPv4-mapped `127.x`. The unspecified addresses
 * (`0.0.0.0`, `::`, every interface) are not.
 */
export function isLoopbackAddress(address: string): boolean {
  if (address === '::1') return true;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return isIPv4(v4) && v4.startsWith('127.');
}

/**
 * Re-reads the TLS files and applies them to `servers` with
 * `setSecureContext`, so new connections get the new certificate and open ones
 * carry on (okf:architecture/configuration). A failed reload keeps the old certificate and
 * logs a warning. Returns whether the new pair was applied.
 */
export function reloadTls(
  servers: readonly ServerType[],
  files: TlsFiles,
  logger: Logger,
): boolean {
  let material: TlsMaterial;
  try {
    material = readTlsMaterial(files);
  } catch (err) {
    logger.warn(
      { err, certFile: files.certFile, keyFile: files.keyFile },
      'TLS reload failed; keeping the current certificate',
    );
    return false;
  }
  for (const server of servers) (server as HttpsServer).setSecureContext(material);
  logger.info({ certFile: files.certFile }, 'TLS certificate reloaded');
  return true;
}

/**
 * Calls `reload` on `SIGHUP`, so a tool that renews the certificate can signal
 * Multitap instead of restarting it. Windows has no `SIGHUP`; restart there.
 * Returns a function that removes the handler.
 */
export function onReloadSignal(reload: () => void): () => void {
  if (process.platform === 'win32') return () => undefined;
  const handler = () => {
    reload();
  };
  process.on('SIGHUP', handler);
  return () => {
    process.off('SIGHUP', handler);
  };
}
