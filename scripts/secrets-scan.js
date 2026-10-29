// `pnpm run secrets:scan [mode]`: betterleaks with this repo's config
// (.betterleaks.toml). Findings are always redacted, so the output is safe to
// paste or to leave in a transcript. Procedure: knowledge/process/secrets-sweep.md.
//
// Modes:
//   staged    (default) the staged files, as staged: the pre-commit hook.
//   all       full history, staged and unstaged changes and untracked files: before
//             a push, a release or reporting done (`pnpm run ci` runs this).
//   history   full git history only: before publishing a repository.
//   paths <file|dir>...  files outside git: core logs, reports, scratch notes.
//
// Flags: --optional  skip with a warning when betterleaks is not installed
//                    (ci on Linux/WSL); the default is to fail.
// Env:   BETTERLEAKS                 path to the binary (else PATH, else ~/.local/bin).
//        BETTERLEAKS_EXTRA_PATTERN   an RE2 regex for your own current passwords,
//                                    provider names or addresses. Kept in the shell,
//                                    never in the repo.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const args = process.argv.slice(2);
const optional = args.includes('--optional');
const [mode = 'staged', ...rest] = args.filter((a) => !a.startsWith('--'));
const exe = process.platform === 'win32' ? 'betterleaks.exe' : 'betterleaks';

function findBinary() {
  const candidates = [process.env.BETTERLEAKS, join(homedir(), '.local', 'bin', exe)];
  const fromPath = spawnSync(exe, ['version'], { encoding: 'utf8' });
  if (fromPath.status === 0) return exe;
  return candidates.find((c) => c && existsSync(c));
}

const bin = findBinary();
if (!bin) {
  const msg =
    'secrets:scan: betterleaks is not installed (put it on PATH, in ~/.local/bin, or set BETTERLEAKS).';
  if (optional) {
    console.warn(`${msg} Skipped.`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

// The shared config, plus your own values when set.
let scratch;
let config = join(root, '.betterleaks.toml');
const extra = process.env.BETTERLEAKS_EXTRA_PATTERN;
if (extra) {
  scratch = mkdtempSync(join(tmpdir(), 'multitap-secrets-'));
  config = join(scratch, 'config.toml');
  const rule = `\n[[rules]]\nid = "multitap-local-values"\ndescription = "A value from BETTERLEAKS_EXTRA_PATTERN"\nregex = '''${extra}'''\nkeywords = []\nconfidence = "high"\n`;
  writeFileSync(config, readFileSync(join(root, '.betterleaks.toml'), 'utf8') + rule, {
    mode: 0o600,
  });
}

const common = [
  '-c',
  config,
  '--ignore-file',
  join(root, '.betterleaksignore'),
  '--no-banner',
  '--redact',
  '--no-color',
];
const run = (label, argv) => {
  const result = spawnSync(bin, [...argv, ...common], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`secrets:scan: ${label}: findings (redacted above) or an error.`);
    return false;
  }
  return true;
};

let ok = true;
// Files added, copied, modified or renamed in the index (`--cached`) or the working tree.
const changed = (...diffArgs) =>
  spawnSync('git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', ...diffArgs], {
    cwd: root,
    encoding: 'utf8',
  })
    .stdout.split('\0')
    .filter(Boolean);

// betterleaks 2.0.0-rc.5 dropped `git --staged`/`--unstaged`, so changes are scanned
// as files with `fs`, which every version has. Staged files are scanned as staged:
// copied out of the index into a mirror tree, so path-based filters still apply.
let staging;
const scanStaged = () => {
  const files = changed('--cached');
  if (files.length === 0) return true;
  staging = mkdtempSync(join(tmpdir(), 'multitap-staged-'));
  const copy = spawnSync('git', ['checkout-index', '-z', '--stdin', `--prefix=${staging}/`], {
    cwd: root,
    input: files.join('\0'),
  });
  if (copy.status !== 0) {
    console.error('secrets:scan: could not copy the staged files out of the index.');
    return false;
  }
  return run('staged changes', ['fs', staging]);
};
const scanUnstaged = () =>
  changed()
    .filter((file) => existsSync(join(root, file)))
    .reduce((clean, file) => run(`unstaged ${file}`, ['fs', join(root, file)]) && clean, true);

try {
  if (mode === 'staged') {
    ok = scanStaged();
  } else if (mode === 'history') {
    ok = run('git history', ['git', root]);
  } else if (mode === 'all') {
    ok = run('git history', ['git', root]);
    ok = scanStaged() && ok;
    ok = scanUnstaged() && ok;
    const untracked = spawnSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .stdout.split('\0')
      .filter(Boolean);
    for (const file of untracked) ok = run(`untracked ${file}`, ['fs', join(root, file)]) && ok;
  } else if (mode === 'paths') {
    if (rest.length === 0) {
      console.error('secrets:scan paths: give at least one file or directory.');
      process.exit(2);
    }
    for (const path of rest) ok = run(path, ['fs', path]) && ok;
  } else {
    console.error(`secrets:scan: unknown mode "${mode}" (staged, all, history, paths).`);
    process.exit(2);
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (staging) rmSync(staging, { recursive: true, force: true });
}
if (!ok) process.exit(1);
console.log(`secrets:scan: ${mode}: clean`);
