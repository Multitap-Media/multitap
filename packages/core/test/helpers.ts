import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey, type ApiKeyScope } from '../src/auth/keys.ts';
import { loadConfig, type LogLevel } from '../src/config.ts';
import { migrateToLatest, openDatabase, type Db } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { createLogger, type Logger } from '../src/log.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';

/** A logger whose JSON lines are kept in memory. */
export function memoryLogger(level: LogLevel = 'info'): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger({ level, destination: stream });
  const text = () => chunks.join('');
  return {
    logger,
    text,
    lines: () =>
      text()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A clock tests move by hand. */
export function manualClock(start = Date.parse('2026-09-27T12:00:00.000Z')) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms: number) => {
    now += ms;
  };
  return clock;
}

export async function migratedMemoryDb(): Promise<Db> {
  const db = openDatabase(':memory:');
  await migrateToLatest(db);
  return db;
}

/** An app over a fresh in-memory database. */
export async function testApp() {
  const db = await migratedMemoryDb();
  const log = memoryLogger();
  const clock = manualClock();
  const config = loadConfig({ NODE_ENV: 'test' });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const streams = new StreamStore({ clock });
  const subtitles = new SubtitleService({ addons, clock, logger: log.logger });
  const metrics = new MetricsRegistry();
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    streams,
    subtitles,
    metrics,
  });
  const keyFor = async (scope: ApiKeyScope) =>
    (await createApiKey(db, { scope, label: `test ${scope}` }, clock)).key;
  return { app, db, log, clock, keyFor, addons, streams, subtitles, metrics, config };
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** A temporary directory removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'multitap-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
