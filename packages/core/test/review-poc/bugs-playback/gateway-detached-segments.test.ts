/**
 * Review PoC (bugs-playback): every segment request through the gateway runs
 * the engine's transcode to its end, even a `HEAD` and even when the viewer is
 * already gone, with no bound on how many such detached reads run at once. A
 * media token holder can make the engine transcode every segment of a title
 * with a burst of cheap `HEAD` requests (or GETs it drops at once).
 */
import { expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.ts';
import { createMediaApp } from '../../../src/gateway/app.ts';
import { memoryLogger } from '../../helpers.ts';

it.fails('HEAD on segments does not make the engine transcode them to the end', async () => {
  let started = 0;
  let readToEnd = 0;
  const engines = {
    fetchMedia: (_handle: unknown, _file: string, signal?: AbortSignal) => {
      started += 1;
      let chunks = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // A "transcode": a few chunks, slowly.
          await new Promise((r) => setTimeout(r, 5));
          if (signal?.aborted === true) {
            controller.error(new Error('aborted'));
            return;
          }
          chunks += 1;
          if (chunks > 3) {
            readToEnd += 1;
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(1000));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  };
  const record = { id: 'ps_x', item: { type: 'movie', id: 'tt1' } };
  const services = {
    sessions: {
      mediaTarget: () =>
        Promise.resolve({ kind: 'ready', session: record, handle: { engineId: 'e', sid: 's' } }),
      touch: () => Promise.resolve(),
    },
    engines,
    gateway: {
      tokens: {
        verify: () => Promise.resolve({ ok: true, claims: { sessionId: 'ps_x', subject: 'v' } }),
      },
      viewers: { request: () => undefined, bytes: () => undefined },
      subtitles: {},
    },
  };
  const app = createMediaApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    logger: memoryLogger().logger,
    services: services as never,
  });

  const N = 50;
  const responses = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve(
        app.fetch(new Request(`http://media/media/a.b.c/seg${String(i)}.ts`, { method: 'HEAD' })),
      ),
    ),
  );
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  // 50 HEADs started 50 engine segment reads, every one read to its end.
  console.log({ started, readToEnd });
  expect(readToEnd).toBe(0);
});
