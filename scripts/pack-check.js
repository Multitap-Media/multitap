// `pnpm run pack:check` (part of `pnpm run ci`): the three packages work for a
// consumer outside the workspace, as published (okf:process/core-release).
//
// 1. `pnpm run build`, then `pnpm pack` each package into a temporary directory.
// 2. Each tarball holds only its `files` (no src/ or test/), dist/index.js and
//    dist/index.d.ts, and a manifest without `development`, `src/` or
//    `workspace:` entries.
// 3. A scratch project outside the workspace installs the tarballs with npm,
//    imports all three with plain `node` (no `development` condition), and
//    typechecks a consumer with strict NodeNext settings and no skipLibCheck.
//
// Needs the npm registry for the packages' own dependencies.
// Usage: pnpm run pack:check [--keep]   (--keep leaves the scratch directory)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * A `.tgz` as a map of file names to contents. Plain ustar plus pax `path`
 * records, which is what `pnpm pack` writes; no system tar needed (Git's tar
 * on Windows reads `C:` as a remote host).
 */
function readTarball(file) {
  const tar = gunzipSync(readFileSync(file));
  const out = new Map();
  const text = (from, to) => tar.toString('utf8', from, to).replace(/\0.*$/s, '');
  let paxPath;
  for (let at = 0; at + 512 <= tar.length;) {
    const name = text(at, at + 100);
    if (name === '') break;
    const size = Number.parseInt(text(at + 124, at + 136).trim() || '0', 8);
    const type = text(at + 156, at + 157);
    const prefix = text(at + 345, at + 500);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
    } else {
      if (type === '0' || type === '') {
        out.set(paxPath ?? (prefix === '' ? name : `${prefix}/${name}`), body);
      }
      paxPath = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const root = dirname(import.meta.dirname);
const keep = process.argv.includes('--keep');
const PACKAGES = {
  'addon-protocol': ['dist'],
  api: ['dist', 'openapi.json'],
  core: ['dist', 'migrations', 'dev'],
};
const ALWAYS = /^package\/(package\.json|LICENSE[^/]*|README[^/]*)$/i;
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version;
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');

// On Windows pnpm and npm are .cmd shims, which need a shell; the arguments are ours.
const run = (cmd, args, cwd) => {
  const result =
    process.platform === 'win32' && cmd !== process.execPath
      ? spawnSync([cmd, ...args.map((a) => `"${a}"`)].join(' '), {
          cwd,
          stdio: 'inherit',
          shell: true,
        })
      : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (in ${cwd})`);
};

const problems = [];
const scratch = mkdtempSync(join(tmpdir(), 'multitap-pack-'));
try {
  run(process.execPath, [join(root, 'scripts/build-dist.js')], root);

  const tarballs = join(scratch, 'tarballs');
  mkdirSync(tarballs);
  const deps = {};
  for (const [name, files] of Object.entries(PACKAGES)) {
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', name));
    const tarball = readdirSync(tarballs).find((f) => f.startsWith(`multitap-${name}-`));
    if (tarball === undefined) throw new Error(`no tarball for @multitap/${name}`);
    const file = join(tarballs, tarball);
    deps[`@multitap/${name}`] = `file:${file}`;

    const contents = readTarball(file);
    const entries = [...contents.keys()];
    const allowed = (e) =>
      ALWAYS.test(e) || files.some((f) => e === `package/${f}` || e.startsWith(`package/${f}/`));
    for (const e of entries.filter((x) => !allowed(x)))
      problems.push(`@multitap/${name}: packs ${e}`);
    for (const need of ['package/dist/index.js', 'package/dist/index.d.ts']) {
      if (!entries.includes(need)) problems.push(`@multitap/${name}: ${need} missing`);
    }
    const manifest = contents.get('package/package.json')?.toString('utf8') ?? '';
    for (const bad of ['"development"', './src/', 'workspace:']) {
      if (manifest.includes(bad))
        problems.push(`@multitap/${name}: packed package.json contains ${bad}`);
    }
  }

  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  const write = (file, text) => writeFileSync(join(consumer, file), text);
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'multitap-pack-check',
        private: true,
        type: 'module',
        dependencies: deps,
        devDependencies: { '@types/node': rootPkg.devDependencies['@types/node'] },
      },
      null,
      2,
    )}\n`,
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    consumer,
  );

  write(
    'smoke.mjs',
    `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrivateHostGuard, StreamSchema } from '@multitap/addon-protocol';
import { createMultitapClient } from '@multitap/api';
import { loadConfig, startMultitap } from '@multitap/core';

const checks = { PrivateHostGuard, StreamSchema, createMultitapClient, loadConfig, startMultitap };
for (const [name, value] of Object.entries(checks)) {
  if (value === undefined) throw new Error(\`\${name} is not exported\`);
}
const doc = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@multitap/api/openapi.json'), 'utf8'));
if (doc.info.version !== ${JSON.stringify(version)}) throw new Error(\`openapi.json is \${doc.info.version}\`);
console.log('pack:check: the packed packages import with plain node');
`,
  );
  run(process.execPath, ['smoke.mjs'], consumer);

  write(
    'consumer.ts',
    `import { PrivateHostGuard, StreamSchema } from '@multitap/addon-protocol';
import { createMultitapClient, type MultitapClient, type MultitapEvent } from '@multitap/api';
import { loadConfig, startMultitap, type RunningMultitap } from '@multitap/core';

const client: MultitapClient = createMultitapClient({ baseUrl: 'http://127.0.0.1:8080', apiKey: 'key' });

export async function whoami(): Promise<string | undefined> {
  const { data } = await client.GET('/v1/whoami');
  return data?.id;
}
export type Event = MultitapEvent;
export const parseStream = (input: unknown) => StreamSchema.parse(input);
export const guard = new PrivateHostGuard({ allow: ['127.0.0.1'] });
export const start: (...args: Parameters<typeof startMultitap>) => Promise<RunningMultitap> = startMultitap;
export const config = loadConfig;
`,
  );
  write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          lib: ['ES2024'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  // Errors in our packages or the consumer fail the check. Errors inside other
  // dependencies' declarations (with skipLibCheck off) are theirs: reported only.
  const typecheck = spawnSync(process.execPath, [tsc, '-p', consumer], {
    cwd: consumer,
    encoding: 'utf8',
  });
  const errors = `${typecheck.stdout}${typecheck.stderr}`
    .split(/\r?\n/)
    .filter((line) => /error TS\d+/.test(line));
  const ours = (line) => line.startsWith('consumer.ts') || line.includes('node_modules/@multitap/');
  for (const line of errors.filter((l) => !ours(l))) console.warn(`pack:check: not ours: ${line}`);
  for (const line of errors.filter(ours)) problems.push(`typecheck: ${line}`);
  if (typecheck.status !== 0 && errors.length === 0) {
    problems.push(`typecheck: tsc exited ${String(typecheck.status)} without an error line`);
  }
  console.log('pack:check: a strict NodeNext consumer typechecked against the packed packages');
} finally {
  if (keep) console.log(`pack:check: scratch directory kept: ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`pack:check: ${p}`);
  process.exitCode = 1;
} else {
  console.log('pack:check: ok');
}
