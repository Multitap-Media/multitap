/**
 * Multitap for a client's full-stack tests: a real Multitap process
 * with fake addons and the playable fake engine, so a browser plays the
 * committed test-pattern clip through Multitap's media gateway. Offline.
 *
 *   node --conditions=development test/harness/stack.ts
 *
 * Environment: `STACK_CORS_ORIGINS` (the client's origin, for the media
 * listener's CORS); `STACK_PLAYABLE_REPEAT` (copies of the 2-minute clip the fake
 * engine serves as one playlist, default 6 = 12 minutes). When everything listens it prints one line,
 * `MULTITAP_STACK_READY {json}`, with Multitap's API URL, its media origin and two
 * keys made with the CLI for this run (client and admin, never logged
 * elsewhere), then runs until SIGINT/SIGTERM or its stdin closes, and removes
 * its temp directory.
 *
 * Stdin also takes newline-delimited JSON commands that steer the fake engine
 * (a forced stall without a second channel to the engine process):
 *   {"delay": {"segment": "seg5.ts", "ms": 3000}}  extra delay before that segment
 *                                                  (a `{sid}/seg5.ts` key works too)
 *   {"delay": {"clear": true}}                     drop every delay
 * A bad line is reported on stderr and ignored; stdin closing still stops the stack.
 *
 * As the contract run (test/contract/run.ts): Cinemeta and Torrentio from the
 * captured fixtures, installed through `/v1/admin/addons`, and the fake engine
 * (`playableMedia`, knowing every fixture torrent, with a second audio language) as the
 * `home` engine, plus a subtitles addon (`SAMPLE_SUBTITLE_FILES`).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURES_DIR,
  SAMPLE_SUBTITLE_FILES,
  SUBTITLES_MANIFEST,
  startFakeAddon,
  type FakeAddon,
} from '../fakes/addon.ts';
import { HOME_ENGINE } from '../engine-fixture.ts';
import { FakeEngine, type FakeTorrent } from '../fakes/engine.ts';

export const READY_PREFIX = 'MULTITAP_STACK_READY ';
const MULTITAP_DIR = join(import.meta.dirname, '../..');

/**
 * Applies one stdin command line to the engine's segment delays. Returns an error
 * message, or undefined when applied.
 */
export function applyStackCommand(
  engine: Pick<FakeEngine, 'segmentDelays'>,
  line: string,
): string | undefined {
  let cmd: unknown;
  try {
    cmd = JSON.parse(line);
  } catch {
    return `not JSON: ${line}`;
  }
  const delay = (cmd as { delay?: { segment?: unknown; ms?: unknown; clear?: unknown } } | null)
    ?.delay;
  if (delay === undefined || typeof delay !== 'object') return `unknown command: ${line}`;
  if (delay.clear === true) {
    engine.segmentDelays.clear();
    return undefined;
  }
  if (typeof delay.segment === 'string' && typeof delay.ms === 'number' && delay.ms >= 0) {
    engine.segmentDelays.set(delay.segment, delay.ms);
    return undefined;
  }
  return `bad delay command: ${line}`;
}

/** Playable-clip copies from `STACK_PLAYABLE_REPEAT` (default 6 = 12 minutes). */
export function playableRepeatFromEnv(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 1 ? n : 6;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function fixtureTorrents(): Record<string, FakeTorrent> {
  const torrents: Record<string, FakeTorrent> = {};
  const dir = join(FIXTURES_DIR, 'torrentio-public');
  for (const file of readdirSync(dir).filter((name) => name.startsWith('stream-'))) {
    const { streams } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      streams: { infoHash?: string; fileIdx?: number; behaviorHints?: { filename?: string } }[];
    };
    for (const stream of streams) {
      if (stream.infoHash === undefined) continue;
      // Enough files for the stream's `fileIdx` (a season pack points past the first).
      const index = stream.fileIdx ?? 0;
      torrents[stream.infoHash] = {
        files: Array.from({ length: index + 1 }, (_, i) => ({
          name:
            i === index
              ? (stream.behaviorHints?.filename ?? 'video.mkv')
              : `other-${String(i)}.nfo`,
          length: i === index ? 2_000_000_000 : 1_000,
        })),
      };
    }
  }
  return torrents;
}

async function waitForHealth(base: string, multitap: ChildProcess, log: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (multitap.exitCode !== null) {
      throw new Error(
        `Multitap exited with ${String(multitap.exitCode)}:\n${readFileSync(log, 'utf8')}`,
      );
    }
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Multitap did not become healthy in 30 s');
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'multitap-stack-'));
  const log = join(tmp, 'multitap.log');
  const fakes: FakeAddon[] = [];
  let engine: FakeEngine | undefined;
  let multitap: ChildProcess | undefined;
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    const child = multitap;
    if (child?.exitCode === null) {
      const exited = new Promise<boolean>((resolve) => {
        child.once('exit', () => {
          resolve(true);
        });
      });
      child.kill('SIGTERM');
      const timeout = new Promise<boolean>((resolve) => setTimeout(resolve, 5_000, false));
      if (!(await Promise.race([exited, timeout]))) child.kill('SIGKILL');
    }
    await Promise.all([...fakes.map((fake) => fake.close()), engine?.close()]);
    // Multitap runs at warn: whatever it logged is worth seeing.
    try {
      const logged = readFileSync(log, 'utf8').trim();
      if (logged !== '')
        process.stderr.write(`multitap stack: Multitap logged:
${logged}
`);
    } catch {
      // No log yet.
    }
    rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  };
  process.once('SIGINT', () => void stop(0));
  process.once('SIGTERM', () => void stop(0));
  // A closed stdin stops it too: on Windows a signal kills without cleanup,
  // which would leave Multitap running.
  process.stdin.on('end', () => void stop(0));
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line === '' || engine === undefined) continue;
      const error = applyStackCommand(engine, line);
      if (error !== undefined) process.stderr.write(`multitap stack: ${error}\n`);
    }
  });
  process.stdin.resume();

  try {
    const port = await freePort();
    const mediaPort = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const mediaOrigin = `http://127.0.0.1:${String(mediaPort)}`;
    const env = {
      ...process.env,
      MULTITAP_API_PORT: String(port),
      MULTITAP_MEDIA_PORT: String(mediaPort),
      MULTITAP_MEDIA_PUBLIC_BASE: mediaOrigin,
      MULTITAP_MEDIA_TOKEN_SECRET: randomBytes(32).toString('base64url'),
      MULTITAP_CORS_ORIGINS: process.env.STACK_CORS_ORIGINS ?? '',
      MULTITAP_DATA_DIR: join(tmp, 'data'),
      NODE_ENV: 'test',
      MULTITAP_LOG_LEVEL: process.env.STACK_LOG_LEVEL ?? 'warn',
      // The fake subtitles addon serves its files from loopback.
      MULTITAP_ADDON_PRIVATE_ALLOW: '127.0.0.1',
    };
    const key = (scope: 'client' | 'admin') =>
      (
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--conditions=development',
              'src/cli.ts',
              'api-key',
              'create',
              '--scope',
              scope,
              '--label',
              `e2e-${scope}`,
              '--json',
            ],
            { cwd: MULTITAP_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
          ),
        ) as { key: string }
      ).key;
    const adminKey = key('admin');
    const clientKey = key('client');

    fakes.push(await startFakeAddon({ fixture: 'cinemeta' }));
    fakes.push(await startFakeAddon({ fixture: 'torrentio-public', emptyWhenUnknown: true }));
    // Subtitles (English, Italian, French) to pick, offered for every title.
    fakes.push(
      await startFakeAddon({
        fixture: 'cinemeta',
        manifest: SUBTITLES_MANIFEST,
        subtitleFiles: SAMPLE_SUBTITLE_FILES,
      }),
    );
    engine = new FakeEngine({
      playableMedia: true,
      // Two audio languages (the clip's one track served twice) to pick between.
      defaultProbe: 'playable-two-audio',
      playableRepeat: playableRepeatFromEnv(process.env.STACK_PLAYABLE_REPEAT),
      torrents: fixtureTorrents(),
    });
    const engineAddress = await engine.listen();

    const fd = openSync(log, 'a');
    multitap = spawn(process.execPath, ['--conditions=development', 'src/index.ts'], {
      cwd: MULTITAP_DIR,
      env,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    await waitForHealth(base, multitap, log);

    const headers = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
    // Multitap seeds no engine: the fake one is the only engine, so the default.
    const put = await fetch(`${base}/v1/admin/engines/home`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...HOME_ENGINE, id: undefined, address: engineAddress }),
    });
    if (put.status !== 201)
      throw new Error(`adding the fake engine as home: ${String(put.status)}`);
    for (const fake of fakes) {
      const res = await fetch(`${base}/v1/admin/addons`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ manifestUrl: fake.manifestUrl }),
      });
      if (res.status !== 201) throw new Error(`installing a fake addon: ${String(res.status)}`);
    }
    process.stdout.write(
      `${READY_PREFIX}${JSON.stringify({ apiUrl: base, mediaOrigin, clientKey, adminKey })}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `multitap stack: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    await stop(1);
  }
}

if (import.meta.main) await main();
