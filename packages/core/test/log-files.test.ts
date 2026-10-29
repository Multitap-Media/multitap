import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  REDACT_CENSOR,
  UNREDACTED_FILES_WARNING,
  createLogger,
  flushLogFile,
  openLogFile,
  type LogFileStream,
} from '../src/log.ts';

const FAKE_KEY = 'FAKEdebridKEY0123456789abcdef';

let dir: string;
let logs: string;
let file: LogFileStream | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'multitap-logs-'));
  logs = join(dir, 'nested', 'logs');
});

afterEach(() => {
  file?.end();
  file = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const names = () => readdirSync(logs).filter((name) => name.endsWith('.log'));
const readAll = () =>
  names()
    .map((name) => readFileSync(join(logs, name), 'utf8'))
    .join('');

function memoryStdout() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function open(env: Record<string, string> = {}) {
  const config = loadConfig({ MULTITAP_LOG_DIR: logs, ...env });
  file = await openLogFile(config.logging);
}

/** Lets the file stream's asynchronous writes finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  flushLogFile(file);
}

// Real file I/O: the first test took 6.4 s under the full suite's parallel load
// on Windows (about 3 s alone), past Vitest's 5 s default.
describe('log files (MULTITAP_LOG_DIR)', { timeout: 20_000 }, () => {
  it('writes JSON lines to a dated file, creating the directory, and to stdout as well', async () => {
    await open();
    const out = memoryStdout();
    const logger = createLogger({ level: 'info', file, destination: out.stream });
    logger.info({ port: 8080 }, 'hello');
    await settle();

    expect(names()).toHaveLength(1);
    expect(names()[0]).toMatch(/^multitap\.\d{4}-\d{2}-\d{2}\.1\.log$/);
    expect(JSON.parse(readAll())).toMatchObject({ msg: 'hello', port: 8080 });
    expect(out.text()).toContain('"msg":"hello"');
  });

  it('writes only to the file with stdout off', async () => {
    await open();
    const out = memoryStdout();
    const logger = createLogger({ level: 'info', file, stdout: false, destination: out.stream });
    logger.info('only in the file');
    await settle();
    expect(out.text()).toBe('');
    expect(readAll()).toContain('only in the file');
  });

  it('redacts secrets in the file like on stdout, at info and above', async () => {
    await open();
    const logger = createLogger({ level: 'info', file, stdout: false });
    logger.info({ manifestUrl: `https://addon.example/${FAKE_KEY}/manifest.json`, n: 1 }, 'x');
    await settle();
    expect(readAll()).not.toContain(FAKE_KEY);
    expect(readAll()).toContain(REDACT_CENSOR);
  });

  it('at debug warns that the log files contain credentials', async () => {
    await open();
    const out = memoryStdout();
    const logger = createLogger({ level: 'debug', file, destination: out.stream });
    logger.debug({ manifestUrl: `https://addon.example/${FAKE_KEY}/manifest.json` }, 'x');
    await settle();
    expect(UNREDACTED_FILES_WARNING).toMatch(/log files .* contain credentials/);
    expect(readAll()).toContain(UNREDACTED_FILES_WARNING);
    expect(readAll()).toContain(FAKE_KEY);
    expect(out.text()).toContain(UNREDACTED_FILES_WARNING);
  });

  it('rotates by size and keeps MULTITAP_LOG_FILE_KEEP rotated files besides the current one', async () => {
    await open({ MULTITAP_LOG_FILE_MAX_SIZE: '1M', MULTITAP_LOG_FILE_KEEP: '2' });
    const logger = createLogger({ level: 'info', file, stdout: false });
    const padding = 'x'.repeat(10_000);
    // About 6 MiB in all: at least five files of 1 MiB, so pruning must act.
    for (let i = 0; i < 600; i++) {
      logger.info({ i, padding }, 'line');
      if (i % 50 === 49) await settle();
    }
    await settle();
    expect(names().length).toBeGreaterThan(1);
    expect(names().length).toBeLessThanOrEqual(3);
    // The newest line survived; the oldest rotated out.
    expect(readAll()).toContain('"i":599');
    expect(readAll()).not.toContain('"i":0,');
  });
});
