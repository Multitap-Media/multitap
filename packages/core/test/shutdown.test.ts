/**
 * Graceful shutdown with an open `/v1/events` stream (okf:architecture/core-events-sse):
 * `RunningMultitap.close()` ends the stream instead of waiting for the client, so
 * held-back library progress is flushed and the database closed well inside
 * `main`'s 8 s force-exit. Began as an adversarial review PoC
 * (okf:core-review/bugs-playback-shutdown-hangs-on-sse).
 *
 * Also: the data folder's single-instance lock, failed startups, and what
 * `main` does on signals and uncaught errors (okf:architecture/core-deployment).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { DB_FILE, migrateToLatest, openDatabase } from '../src/db/index.ts';
import { DataDirLockedError, LOCK_FILE, lockDataDir } from '../src/db/instance-lock.ts';
import { listen } from '../src/http/listen.ts';
import {
  processHandlers,
  SHUTDOWN_TIMEOUT_MS,
  startMultitap,
  type ProcessHandlerDeps,
} from '../src/index.ts';
import { memoryLogger, tempDir } from './helpers.ts';

const INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const LOCK_MODULE = fileURLToPath(new URL('../src/db/instance-lock.ts', import.meta.url));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('RunningMultitap.close() resolves promptly while an SSE client is connected', async () => {
  const dir = tempDir();
  cleanups.push(dir.cleanup);
  const { logger } = memoryLogger();
  // A key, created the way the CLI does before Multitap starts.
  const db = openDatabase(join(dir.dir, DB_FILE));
  await migrateToLatest(db, logger);
  const { key } = await createApiKey(db, { scope: 'client', label: 'test' }, () => Date.now());
  await db.destroy();

  const loaded = loadConfig({ NODE_ENV: 'test', MULTITAP_DATA_DIR: dir.dir });
  const multitap = await startMultitap(
    { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } },
    logger,
  );

  const sse = new AbortController();
  cleanups.push(() => {
    sse.abort();
  });
  const res = await fetch(`http://127.0.0.1:${String(multitap.port)}/v1/events`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: sse.signal,
  });
  expect(res.status).toBe(200);
  // Read the ': connected' comment so the stream is really open.
  if (!res.body) throw new Error('expected a stream body');
  const reader = res.body.getReader();
  await reader.read();

  const started = Date.now();
  const closed = multitap.close().then(() => 'closed' as const);
  const timedOut = new Promise<'timeout'>((r) =>
    setTimeout(() => {
      r('timeout');
    }, 3_000),
  );
  const outcome = await Promise.race([closed, timedOut]);
  sse.abort();
  await closed.catch(() => undefined);
  expect(outcome).toBe('closed');
  // Ended by Multitap, not by the grace period cutting the connection.
  expect(Date.now() - started).toBeLessThan(2_000);

  // The client sees the stream end (and would reconnect with Last-Event-ID).
  const rest = await reader.read().catch(() => ({ done: true }));
  expect(rest.done).toBe(true);
}, 15_000);

it('a listener cuts a response still open after the grace period', async () => {
  // A response that never ends, like a segment streaming to a stalled player.
  const listener = await listen(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
        }),
      ),
    0,
    null,
    '127.0.0.1',
  );
  const res = await fetch(`http://127.0.0.1:${String(listener.port)}/`);
  if (!res.body) throw new Error('expected a stream body');
  await res.body.getReader().read();

  const started = Date.now();
  await listener.close(200);
  expect(Date.now() - started).toBeLessThan(2_000);
});

function configIn(dataDir: string, env: Record<string, string> = {}): Config {
  const loaded = loadConfig({ NODE_ENV: 'test', MULTITAP_DATA_DIR: dataDir, ...env });
  return { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } };
}

function scratch(): string {
  const dir = tempDir();
  cleanups.push(dir.cleanup);
  return dir.dir;
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('the data folder lock', () => {
  it('a second Multitap on the same folder stops before it touches the database', async () => {
    const dataDir = scratch();
    const first = await startMultitap(configIn(dataDir), memoryLogger().logger);
    cleanups.push(() => first.close());

    // A session the first instance is resolving, written after its start().
    const side = openDatabase(join(dataDir, DB_FILE));
    const { SqliteSessionRepository } = await import('../src/sessions/sqlite-repository.ts');
    const repo = new SqliteSessionRepository(side);
    await repo.create(
      {
        id: 'ps_live',
        key: null,
        item: { type: 'movie', id: 'tt0000001' },
        source: { auto: true },
        identity: null,
        candidates: null,
        engineId: 'home',
        delivery: 'transcode',
        mode: 'play',
        highRes: 'off',
        requestedQuality: null,
        readyBy: null,
        retainUntil: null,
      },
      Date.now(),
    );

    let error: unknown;
    try {
      await startMultitap(configIn(dataDir), memoryLogger().logger);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DataDirLockedError);
    expect((error as Error).message).toContain(dataDir);
    expect((error as Error).message).toContain('Another Multitap is already running');
    // Not failed as `interrupted` by the second instance's startup.
    expect((await repo.get('ps_live'))?.status).toBe('resolving');
    await side.destroy();

    const health = await fetch(`http://127.0.0.1:${String(first.port)}/healthz`);
    expect(health.status).toBe(200);

    // close() releases it: the next start on the folder works.
    await first.close();
    const next = await startMultitap(configIn(dataDir), memoryLogger().logger);
    await next.close();
  });

  it('a failed start releases it', async () => {
    const dataDir = scratch();
    const taken = await listen(() => new Response('taken'), 0, null, '127.0.0.1');
    cleanups.push(() => taken.close(0));
    const log = memoryLogger();
    const config = configIn(dataDir, { MULTITAP_MEDIA_BIND: '127.0.0.1' });
    await expect(
      startMultitap({ ...config, media: { ...config.media, port: taken.port } }, log.logger),
    ).rejects.toThrow();
    // The first sweep finished before the database closed (nothing logged an error).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.lines().filter((line) => Number(line.level) >= 50)).toEqual([]);

    const next = await startMultitap(configIn(dataDir), memoryLogger().logger);
    await next.close();
  });

  it('is released by the operating system when its process is killed', async () => {
    const dataDir = scratch();
    // A process that takes the lock and then hangs, as a crashed Multitap would.
    const holder = spawn(
      process.execPath,
      [
        '--conditions=development',
        '--input-type=module',
        '-e',
        `const { lockDataDir } = await import(${JSON.stringify(new URL(`file://${LOCK_MODULE}`).href)});
         lockDataDir(${JSON.stringify(dataDir)}); console.log('locked'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    cleanups.push(() => holder.kill('SIGKILL'));
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
      holder.once('exit', () => {
        reject(new Error('the lock holder exited early'));
      });
    });
    expect(() => lockDataDir(dataDir)).toThrow(DataDirLockedError);

    const exited = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await exited;
    // The stale lock file is still there, but it doesn't hold anything.
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(true);
    lockDataDir(dataDir).release();
  });
});

describe('process handlers (main)', () => {
  function handlers(overrides: Partial<ProcessHandlerDeps> = {}) {
    const log = memoryLogger();
    const exits: number[] = [];
    let flushes = 0;
    let exited!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      exited = resolve;
    });
    const h = processHandlers({
      logger: log.logger,
      close: () => Promise.resolve(),
      flushLogs: () => {
        flushes += 1;
      },
      exit: (code) => {
        exits.push(code);
        exited(code);
      },
      reloadTls: null,
      ...overrides,
    });
    return { h, log, exits, exit, flushes: () => flushes };
  }

  it('waits less than Docker’s default 10 s stop grace', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('a signal closes gracefully, then exits 0 once', async () => {
    let closed = 0;
    const t = handlers({
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
    t.h.shutdown('SIGTERM');
    t.h.shutdown('SIGINT');
    expect(await t.exit).toBe(0);
    expect(closed).toBe(1);
    expect(t.exits).toEqual([0]);
    expect(t.flushes()).toBeGreaterThan(0);
  });

  it('SIGHUP without TLS is logged and ignored, never a shutdown', () => {
    let closed = false;
    const t = handlers({
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
    t.h.reload();
    expect(closed).toBe(false);
    expect(t.exits).toEqual([]);
    expect(t.log.lines().some((line) => String(line.msg).includes('SIGHUP ignored'))).toBe(true);
  });

  it('SIGHUP with TLS reloads the certificate', () => {
    let reloads = 0;
    const t = handlers({
      reloadTls: () => {
        reloads += 1;
        return true;
      },
    });
    t.h.reload();
    expect(reloads).toBe(1);
    expect(t.exits).toEqual([]);
  });

  it('an uncaught error logs fatal, flushes through close() and exits 1', async () => {
    let closed = false;
    const t = handlers({
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
    t.h.crash(new Error('boom'), 'unhandledRejection');
    expect(await t.exit).toBe(1);
    expect(closed).toBe(true);
    const fatal = t.log.lines().find((line) => line.level === 60);
    expect(fatal).toMatchObject({
      origin: 'unhandledRejection',
      msg: 'uncaught error; shutting down',
    });
  });

  it('an uncaught error exits 1 within its bound when closing hangs', async () => {
    const t = handlers({ close: () => new Promise(() => undefined), crashTimeoutMs: 50 });
    t.h.crash(new Error('boom'), 'uncaughtException');
    expect(await t.exit).toBe(1);
  });

  it('an error during a signal shutdown makes the exit code 1', async () => {
    let finish!: () => void;
    const t = handlers({
      close: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    t.h.shutdown('SIGTERM');
    t.h.crash(new Error('late'), 'uncaughtException');
    // close() is called on the next microtask.
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    expect(await t.exit).toBe(1);
    expect(t.exits).toEqual([1]);
  });

  it.skipIf(process.platform === 'win32')(
    'end to end: SIGHUP without TLS keeps Multitap running, SIGTERM stops it cleanly',
    async () => {
      const dataDir = scratch();
      const apiPort = await freePort();
      const mediaPort = await freePort();
      const child = spawn(process.execPath, ['--conditions=development', INDEX], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MULTITAP_DATA_DIR: dataDir,
          MULTITAP_API_PORT: String(apiPort),
          MULTITAP_MEDIA_PORT: String(mediaPort),
          MULTITAP_API_BIND: '127.0.0.1',
          MULTITAP_MEDIA_BIND: '127.0.0.1',
          MULTITAP_LOG_LEVEL: 'info',
          MULTITAP_NOT_A_SETTING: 'x',
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      cleanups.push(() => child.kill('SIGKILL'));
      let out = '';
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      const waitFor = (text: string) =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (out.includes(text)) resolve();
          };
          child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            check();
          });
          check();
          void exited.then(() => {
            reject(new Error(`exited before "${text}":\n${out}`));
          });
        });
      await waitFor('Multitap listening');
      expect(out).toContain('MULTITAP_NOT_A_SETTING');

      child.kill('SIGHUP');
      await waitFor('SIGHUP ignored');
      const health = await fetch(`http://127.0.0.1:${String(apiPort)}/healthz`);
      expect(health.status).toBe(200);

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out).toContain('shutting down');
    },
    30_000,
  );
});
