/**
 * The contract run (phase 1 step 9): Multitap against its own OpenAPI document,
 * with Schemathesis generating the requests. Offline: every addon is a fake.
 *
 *   node --conditions=development test/contract/run.ts [--seed N] [--max-examples N]
 *        [--pass read|admin] [-- <extra schemathesis args>]
 *
 * Run it with `pnpm run contract`, which uses a native Linux checkout
 * (scripts/contract.js, scripts/linux-run.sh), never the Windows node_modules
 * over /mnt/c.
 *
 * Design:
 * 1. A temporary MULTITAP_DATA_DIR and a free port.
 * 2. An admin key, created with the real CLI (`api-key create --json`).
 * 3. Fake addons from the captured fixtures: Cinemeta (catalogs, meta),
 *    YouTube (a second id prefix), Torrentio (streams), Torrentio RD in
 *    `malformed` mode (the dropped-item path), and a subtitles addon serving
 *    SRT, ASS and WebVTT files. Multitap is started as a real process
 *    (`src/index.ts`) and the addons are installed through `/v1/admin/addons`.
 *    The Cinemeta addon id and one listed subtitle file are handed to
 *    schemathesis.toml, which pins them for getCatalog and getSubtitleFile
 *    (no link reaches those operations).
 *    The fake engine (test/fakes/engine.ts) listens on a loopback port and is
 *    added as engine `home` (`PUT /v1/admin/engines/home`, with the test
 *    fixture's capabilities; Multitap seeds no engine). It knows every torrent in the
 *    Torrentio fixtures, so auto-selected sessions for the example items
 *    reach `ready` on it; it never runs ffmpeg.
 * 4. Schemathesis runs in three passes against the same Multitap, with a fixed
 *    seed, no example database (so a run doesn't depend on earlier ones),
 *    one worker, `--checks all` except the two auth checks that expect
 *    401/403 (Multitap answers 404, okf:architecture/core-api-keys-security), and every phase (examples, coverage,
 *    fuzzing, and stateful, following the document's OpenAPI links plus
 *    inferred ones). `streamEvents` (`GET /v1/events`, SSE) is excluded in
 *    schemathesis.toml: the stream never ends. Vitest covers it.
 *    - `read`: every GET. Nothing can change the seeded setup, so browse
 *      routes see real addons throughout, and response-derived data (addon
 *      ids, catalog ids) reaches their parameters.
 *    - `client`: every operation under `/v1/sessions` and `/v1/profiles`.
 *      The stateful phase follows the lifecycle links: create session → get
 *      → update → release, and create profile → progress → library →
 *      continue (→ next, delete). Sessions play on the fake engine.
 *    - `admin`: every `/v1/admin` operation, run second because it may
 *      disable, remove or reorder the seeded addons and replace engines; by
 *      then the browse pass no longer needs them. Deleting the default
 *      engine is a documented 409. The one thing it must not destroy is its
 *      own key: schemathesis.toml keeps response-derived ids away from
 *      `revokeApiKey`, and the harness checks afterwards that the key still
 *      works.
 * 5. Everything is torn down: Schemathesis, Multitap, the fakes, the temp dir.
 *    Multitap runs with `MULTITAP_LOG_LEVEL=warn`: its errors are printed at the end, and
 *    its warnings (mostly fake addons answering 404 for ids they don't have)
 *    are counted.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FIXTURES_DIR,
  SAMPLE_SUBTITLE_FILES,
  startFakeAddon,
  SUBTITLES_MANIFEST,
  type FakeAddon,
  type FakeAddonOptions,
} from '../fakes/addon.ts';
import { HOME_ENGINE } from '../engine-fixture.ts';
import { FakeEngine, type FakeTorrent } from '../fakes/engine.ts';

const MULTITAP_DIR = join(import.meta.dirname, '../..');
const DOCUMENT = join(MULTITAP_DIR, '../../packages/api/openapi.json');
const CONFIG = join(import.meta.dirname, 'schemathesis.toml');

const PASSES = {
  read: ['--include-method', 'GET'],
  client: ['--include-path-regex', '^/v1/(sessions|profiles)(/|$)'],
  admin: ['--include-path-regex', '^/v1/admin/'],
} as const;
type Pass = keyof typeof PASSES;

const { values: opts, positionals: extraArgs } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: 'string', default: process.env.CONTRACT_SEED ?? '20260927' },
    'max-examples': { type: 'string', default: process.env.CONTRACT_MAX_EXAMPLES ?? '30' },
    pass: { type: 'string', multiple: true },
  },
});
const passes = (opts.pass ?? Object.keys(PASSES)) as Pass[];
for (const pass of passes) {
  if (!(pass in PASSES)) throw new Error(`Unknown pass '${pass}'; expected read, client or admin.`);
}

const log = (message: string) => {
  process.stdout.write(`contract: ${message}\n`);
};

function schemathesisBin(): string {
  if (process.env.SCHEMATHESIS) return process.env.SCHEMATHESIS;
  const local = join(homedir(), '.local/bin/schemathesis');
  try {
    execFileSync(local, ['--version'], { stdio: 'ignore' });
    return local;
  } catch {
    return 'schemathesis';
  }
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

async function waitForHealth(base: string, multitap: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (multitap.exitCode !== null) {
      throw new Error(
        `Multitap exited with ${String(multitap.exitCode)}:
${readFileSync(multitapLog, 'utf8').slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Multitap did not become healthy in 20 s');
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'multitap-contract-'));
const dataDir = join(tmp, 'data');
const multitapLog = join(tmp, 'multitap.log');
const fakes: FakeAddon[] = [];
let engine: FakeEngine | undefined;
let multitap: ChildProcess | undefined;

async function teardown(): Promise<void> {
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
  rmSync(tmp, { recursive: true, force: true });
}

/** Every torrent in the Torrentio fixtures, so the fake engine can play them. */
function fixtureTorrents(): Record<string, FakeTorrent> {
  const torrents: Record<string, FakeTorrent> = {};
  const dir = join(FIXTURES_DIR, 'torrentio-public');
  for (const file of readdirSync(dir).filter((name) => name.startsWith('stream-'))) {
    const { streams } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      streams: { infoHash?: string; behaviorHints?: { filename?: string } }[];
    };
    for (const stream of streams) {
      if (stream.infoHash === undefined) continue;
      torrents[stream.infoHash] = {
        files: [{ name: stream.behaviorHints?.filename ?? 'video.mkv', length: 2_000_000_000 }],
      };
    }
  }
  return torrents;
}

async function main(): Promise<number> {
  const port = await freePort();
  const mediaPort = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const env = {
    ...process.env,
    MULTITAP_API_PORT: String(port),
    MULTITAP_MEDIA_PORT: String(mediaPort),
    // A throwaway signing key for this run's media tokens.
    MULTITAP_MEDIA_TOKEN_SECRET: randomBytes(32).toString('base64url'),
    MULTITAP_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    // The admin pass adds and deletes engines; a configured default can't be deleted.
    MULTITAP_SELECTION_DEFAULT_ENGINE: 'home',
    MULTITAP_LOG_LEVEL: 'warn',
    MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '2000',
    MULTITAP_ADDON_TIMEOUT_META_MS: '2000',
    MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '2000',
    MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS: '2000',
    // The fake subtitles addon serves its files from loopback.
    MULTITAP_ADDON_PRIVATE_ALLOW: '127.0.0.1',
  };

  // 1–2. The admin key, through the CLI.
  const created = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--conditions=development',
        'src/cli.ts',
        'api-key',
        'create',
        '--scope',
        'admin',
        '--label',
        'contract',
        '--json',
      ],
      { cwd: MULTITAP_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  ) as { id: string; key: string };
  log(`admin key ${created.id} created with the CLI`);

  // 3. Fakes, then Multitap.
  const addonOptions: FakeAddonOptions[] = [
    { fixture: 'cinemeta' },
    { fixture: 'youtube' },
    { fixture: 'torrentio-public', emptyWhenUnknown: true },
    { fixture: 'torrentio-rd', mode: 'malformed', prefix: '/fake-debrid-key' },
    {
      fixture: 'cinemeta',
      manifest: SUBTITLES_MANIFEST,
      subtitleFiles: SAMPLE_SUBTITLE_FILES,
    },
  ];
  for (const options of addonOptions) fakes.push(await startFakeAddon(options));
  engine = new FakeEngine({ torrents: fixtureTorrents() });
  const engineAddress = await engine.listen();

  const logFd = openSync(multitapLog, 'a');
  multitap = spawn(process.execPath, ['--conditions=development', 'src/index.ts'], {
    cwd: MULTITAP_DIR,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHealth(base, multitap);
  log(`Multitap listening on ${base}`);

  const headers = { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' };

  // The fake engine is the only engine, so it is the default one.
  const put = await fetch(`${base}/v1/admin/engines/home`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...HOME_ENGINE, id: undefined, address: engineAddress }),
  });
  if (put.status !== 201) {
    throw new Error(`adding the fake engine as home failed: ${String(put.status)}`);
  }
  log(`fake engine on ${engineAddress} is 'home'`);
  const installed: { id: string; name: string }[] = [];
  for (const fake of fakes) {
    const res = await fetch(`${base}/v1/admin/addons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ manifestUrl: fake.manifestUrl }),
    });
    if (res.status !== 201) {
      throw new Error(`installing a fake addon failed: ${String(res.status)} ${await res.text()}`);
    }
    const addon = (await res.json()) as { id: string; name: string };
    installed.push(addon);
    log(`installed ${addon.name} (${addon.id})`);
  }

  // Values schemathesis.toml pins: the Cinemeta addon id for getCatalog, and a
  // listed subtitle file for getSubtitleFile.
  const cinemeta = installed.find((addon) => addon.name === 'Cinemeta');
  const subtitles = await fetch(`${base}/v1/subtitles/movie/tt1375666`, { headers });
  const track = subtitles.ok
    ? ((await subtitles.json()) as { subtitles: { id: string; lang: string }[] }).subtitles.find(
        (entry) => entry.lang === 'eng',
      )
    : undefined;
  if (cinemeta === undefined || track === undefined) {
    throw new Error('seeding failed: no Cinemeta addon or no listed subtitle file');
  }
  // The fake engine is wired up: an auto-selected session for a fixture item
  // reaches `ready` on it. It is released again, so the passes start clean.
  const probe = await fetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ item: { type: 'movie', id: 'tt1375666' }, source: { auto: true } }),
  });
  if (probe.status !== 201) throw new Error(`creating a session failed: ${String(probe.status)}`);
  const { id: sessionId } = (await probe.json()) as { id: string };
  let session = { status: 'resolving', failureReason: undefined as string | undefined };
  for (let i = 0; i < 100 && ['resolving', 'preparing'].includes(session.status); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fetch(`${base}/v1/sessions/${sessionId}`, { headers });
    session = (await res.json()) as typeof session;
  }
  if (session.status !== 'ready') {
    throw new Error(
      `a session on the fake engine ended '${session.status}' (${session.failureReason ?? 'no reason'})`,
    );
  }
  await fetch(`${base}/v1/sessions/${sessionId}`, { method: 'DELETE', headers });
  log('a session on the fake engine reached ready');

  const schemathesisEnv = {
    ...process.env,
    MULTITAP_CONTRACT_API_KEY: created.key,
    MULTITAP_CONTRACT_CATALOG_ADDON: cinemeta.id,
    MULTITAP_CONTRACT_SUBTITLE_FILE: `${track.id}.vtt`,
  };

  // 4. Schemathesis, one pass at a time.
  const bin = schemathesisBin();
  const results: [Pass, number][] = [];
  for (const pass of passes) {
    log(`pass '${pass}' (seed ${opts.seed}, up to ${opts['max-examples']} examples per operation)`);
    const common = [
      '--config-file',
      CONFIG,
      'run',
      DOCUMENT,
      '--url',
      base,
      '--seed',
      opts.seed,
      '--max-examples',
      opts['max-examples'],
      '--checks',
      'all',
      '--generation-database',
      'none',
      ...PASSES[pass],
    ];
    // The first two insist on 401/403 without a key; Multitap answers 404 (�11.7).
    // use_after_free expects 404 for a released session, which stays readable
    // as `status: released` by design (�4.8), and it is reported against
    // whichever operation of the stateful sequence (createSession, getSession,
    // releaseSession) the run ends on, so a per-operation switch is not enough.
    const excluded = ['ignored_auth', 'missing_required_header', 'use_after_free'];
    // Main run, every operation and every phase (the stateful one follows the
    // links across methods). negative_data_rejection is off here: it reports
    // "violates additionalProperties" for the unknown query parameters and
    // headers Schemathesis adds to GET requests, which Multitap ignores like any
    // HTTP server (the OpenAPI document declares parameters one by one and
    // cannot forbid extra ones).
    let code = await run(
      bin,
      [
        ...common,
        '--exclude-checks',
        [...excluded, 'negative_data_rejection'].join(','),
        '--phases',
        'examples,coverage,fuzzing,stateful',
        ...extraArgs,
      ],
      schemathesisEnv,
    );
    // Second run, only operations that take a request body or change state
    // (POST, PUT, PATCH, DELETE), with negative_data_rejection on: invalid
    // bodies must be rejected with a 4xx. The false positive above does not
    // arise because these requests' query and headers are the declared ones.
    // The read pass has none of these operations. No stateful phase: it ran above.
    if (pass !== 'read') {
      log(`pass '${pass}', non-GET operations with negative_data_rejection`);
      const negative = await run(
        bin,
        [
          ...common,
          '--include-method-regex',
          '^(POST|PUT|PATCH|DELETE)$',
          '--exclude-checks',
          excluded.join(','),
          '--phases',
          'examples,coverage,fuzzing',
          ...extraArgs,
        ],
        schemathesisEnv,
      );
      if (negative !== 0) code = negative;
    }
    results.push([pass, code]);
  }

  // The key must have survived the admin pass.
  const keys = await fetch(`${base}/v1/admin/api-keys`, { headers });
  const own = keys.ok
    ? ((await keys.json()) as { id: string; revokedAt: string | null }[]).find(
        (key) => key.id === created.id,
      )
    : undefined;
  const keyOk = own?.revokedAt === null;
  if (!keyOk) log("FAIL: the harness's admin key was revoked or stopped working during the run");

  log(
    `fake engine: ${String(engine.creates.length)} torrent creates, ` +
      `${String(engine.masterRequests.length)} master requests, ${String(engine.deletes.length)} deletes`,
  );

  const multitapLines = readFileSync(multitapLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  const levelOf = (line: string) => {
    try {
      return (JSON.parse(line) as { level?: number }).level ?? 60;
    } catch {
      return 60; // Not a log line: a crash, say.
    }
  };
  const errors = multitapLines.filter((line) => levelOf(line) >= 50);
  log(
    `Multitap logged ${String(multitapLines.length - errors.length)} warnings, ${String(errors.length)} errors`,
  );
  for (const line of errors) process.stdout.write(`${line}\n`);

  for (const [pass, code] of results)
    log(`pass '${pass}': ${code === 0 ? 'ok' : `FAIL (exit ${String(code)})`}`);
  return results.every(([, code]) => code === 0) && keyOk ? 0 : 1;
}

let exitCode = 1;
const onSignal = () => {
  void teardown().finally(() => process.exit(130));
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
try {
  exitCode = await main();
} catch (err) {
  process.stderr.write(
    `contract: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
} finally {
  await teardown();
}
process.exit(exitCode);
