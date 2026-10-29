/**
 * Graceful shutdown with an open `/v1/events` stream (okf:architecture/core-events-sse):
 * `RunningMultitap.close()` ends the stream instead of waiting for the client, so
 * held-back library progress is flushed and the database closed well inside
 * `main`'s 10 s force-exit. Began as an adversarial review PoC
 * (okf:core-review/bugs-playback-shutdown-hangs-on-sse).
 */
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { DB_FILE, migrateToLatest, openDatabase } from '../src/db/index.ts';
import { listen } from '../src/http/listen.ts';
import { startMultitap } from '../src/index.ts';
import { memoryLogger, tempDir } from './helpers.ts';

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
