import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { startMultitap, type RunningMultitap } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { DB_FILE, migrateToLatest, openDatabase } from '../src/db/index.ts';
import { getEngineProxyPassword } from '../src/engines/index.ts';
import { addHomeEngine } from './engine-fixture.ts';
import { bearer, memoryLogger, tempDir } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const exec = promisify(execFile);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  return tmp.dir;
}

async function cli(args: string[], dataDir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    env: { MULTITAP_DATA_DIR: dataDir },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

describe('cli', () => {
  it('smoke: `node src/cli.ts api-key create` prints a key once', async () => {
    const dataDir = scratch();
    const { stdout } = await exec(
      process.execPath,
      [
        '--conditions=development',
        CLI,
        'api-key',
        'create',
        '--scope',
        'admin',
        '--label',
        'bootstrap',
      ],
      { env: { ...process.env, MULTITAP_DATA_DIR: dataDir, MULTITAP_LOG_LEVEL: 'info' } },
    );
    expect(stdout).toMatch(/^Created admin key [0-9a-f-]{36} \(bootstrap\)\./);
    const key = /\n\n([A-Za-z0-9_-]{43})\n$/.exec(stdout)?.[1];
    expect(key).toBeDefined();

    const list = await exec(
      process.execPath,
      ['--conditions=development', CLI, 'api-key', 'list'],
      {
        env: { ...process.env, MULTITAP_DATA_DIR: dataDir },
      },
    );
    expect(list.stdout).toContain('bootstrap');
    expect(list.stdout).not.toContain(key);
  });

  it('a key it creates authenticates against a running Multitap', async () => {
    const dataDir = scratch();
    const created = await cli(
      ['api-key', 'create', '--scope', 'admin', '--label', 'bootstrap', '--json'],
      dataDir,
    );
    expect(created.code).toBe(0);
    const { key, id } = JSON.parse(created.stdout) as { key: string; id: string };

    const loaded = loadConfig({ MULTITAP_DATA_DIR: dataDir });
    const config = { ...loaded, apiPort: 0, media: { ...loaded.media, port: 0 } };
    const multitap: RunningMultitap = await startMultitap(config, memoryLogger().logger);
    cleanups.push(() => multitap.close());
    const base = `http://127.0.0.1:${String(multitap.port)}`;

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const res = await fetch(`${base}/v1/admin/api-keys`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ id, label: 'bootstrap' })]);

    // Revoked through the CLI while Multitap runs: the next request is a 404.
    expect((await cli(['api-key', 'revoke', id], dataDir)).code).toBe(0);
    expect((await fetch(`${base}/v1/admin/api-keys`, { headers: bearer(key) })).status).toBe(404);
  });

  it('lists and revokes', async () => {
    const dataDir = scratch();
    expect((await cli(['api-key', 'list'], dataDir)).stdout).toBe('No API keys.\n');
    const { stdout } = await cli(
      ['api-key', 'create', '--scope', 'client', '--label', 'party', '--json'],
      dataDir,
    );
    const { id } = JSON.parse(stdout) as { id: string };

    const listed = await cli(['api-key', 'list', '--json'], dataDir);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id, scope: 'client', label: 'party', revokedAt: null }),
    ]);

    const revoked = await cli(['api-key', 'revoke', id], dataDir);
    expect(revoked).toMatchObject({ code: 0 });
    expect(revoked.stdout).toMatch(new RegExp(`^Revoked key ${id} \\(party\\) at `));

    expect(await cli(['api-key', 'revoke', 'nope'], dataDir)).toMatchObject({
      code: 1,
      stderr: 'No API key with id nope.\n',
    });
  });

  it.each([
    [['api-key', 'create', '--scope', 'root', '--label', 'x']],
    [['api-key', 'create', '--scope', 'client']],
    [['api-key', 'create', '--scope', 'client', '--label', 'x', '--bogus']],
    [['api-key', 'frobnicate']],
    [['api-key', 'revoke']],
    [['other']],
  ])('rejects bad usage %j with exit 2', async (args) => {
    const result = await cli(args, scratch());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
    expect(result.stdout).toBe('');
  });

  it('reports invalid configuration', async () => {
    const result = await runCli(['api-key', 'list'], {
      env: { MULTITAP_API_PORT: 'x' },
      stdout: () => undefined,
      stderr: (text) => {
        expect(text).toContain('MULTITAP_API_PORT');
      },
    });
    expect(result).toBe(1);
  });

  it('engine proxy-password: sets from a file and clears, never printing it', async () => {
    const dataDir = scratch();
    // A fake value only.
    const password = 'FAKEproxyPASSWORD-0123456789';
    const file = join(dataDir, 'proxy-password.txt');
    writeFileSync(file, `${password}\r\n`);
    const db = openDatabase(join(dataDir, DB_FILE));
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);
    await addHomeEngine(db);

    const set = await cli(['engine', 'proxy-password', 'home', '--file', file], dataDir);
    expect(set).toMatchObject({ code: 0, stderr: '' });
    expect(set.stdout).toContain('Set the proxy password of engine home');
    expect(set.stdout).not.toContain(password);
    expect((await getEngineProxyPassword(db, 'home'))?.reveal()).toBe(password);

    expect((await cli(['engine', 'proxy-password', 'home', '--clear'], dataDir)).code).toBe(0);
    expect(await getEngineProxyPassword(db, 'home')).toBeUndefined();

    const unknown = await cli(['engine', 'proxy-password', 'nope', '--file', file], dataDir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No engine with id nope');
    expect((await cli(['engine', 'proxy-password', 'home'], dataDir)).code).toBe(2);
    expect(
      (await cli(['engine', 'proxy-password', 'home', '--clear', '--file', file], dataDir)).code,
    ).toBe(2);
    const missing = await cli(
      ['engine', 'proxy-password', 'home', '--file', join(dataDir, 'none.txt')],
      dataDir,
    );
    expect(missing.code).toBe(1);
  });
});
