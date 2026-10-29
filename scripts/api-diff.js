// `pnpm run api:diff`: breaking-change check of packages/api/openapi.json
// with oasdiff (okf:architecture/core-api-testing). `pnpm run ci` runs it with
// `--optional`.
//
// Baseline:
// - the newest tag matching `v*`: breaking changes fail the check;
// - with no such tag yet, `main`'s committed document: report only;
// - with neither, there is nothing to compare: report "no baseline", exit 0.
// Outside a git checkout (scripts/linux-run.sh copies the tree without .git)
// there is no baseline either; it says so and exits 0.
// `--report-only` never fails.
//
// A deliberate breaking change is accepted by a line in ACCEPTED (oasdiff's
// --err-ignore file: the method, path and change text as oasdiff prints them).
// The release that ships it is a minor bump and empties the file
// (okf:process/core-release).
//
// oasdiff is a Go tool (`go install github.com/oasdiff/oasdiff@latest`). It is
// found as $OASDIFF, on PATH, or in ~/go/bin; on Windows, WSL's copy is used
// when Windows has none. With `--optional`, a missing oasdiff is a warning.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const DOCUMENT = 'packages/api/openapi.json';
const ACCEPTED = 'packages/api/breaking-accepted.txt';
const reportOnlyFlag = process.argv.includes('--report-only');
const optional = process.argv.includes('--optional');

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

function baseline() {
  const tag = tryGit('tag', '--list', 'v[0-9]*', '--sort=-v:refname').split('\n')[0]?.trim();
  if (tag) {
    const doc = tryGit('show', `${tag}:${DOCUMENT}`);
    if (doc !== undefined) return { ref: tag, doc, reportOnly: false };
  }
  const doc = tryGit('show', `main:${DOCUMENT}`);
  if (doc !== undefined) return { ref: 'main', doc, reportOnly: true };
  return undefined;
}

const toWsl = (path) =>
  path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');

class OasdiffMissing extends Error {}

function oasdiff(args) {
  const candidates = [process.env.OASDIFF, 'oasdiff', join(homedir(), 'go/bin/oasdiff')].filter(
    Boolean,
  );
  for (const bin of candidates) {
    const result = spawnSync(bin, args, { stdio: 'inherit' });
    if (!result.error) return result.status ?? 1;
  }
  if (process.platform === 'win32') {
    const wslArgs = args.map((arg) => (/^[A-Za-z]:[\\/]/.test(arg) ? toWsl(arg) : arg));
    const result = spawnSync(
      'wsl',
      ['-e', 'bash', '-lc', '"$HOME/go/bin/oasdiff" "$@"', 'oasdiff', ...wslArgs],
      {
        stdio: 'inherit',
      },
    );
    if (!result.error && result.status !== 127) return result.status ?? 1;
  }
  throw new OasdiffMissing(
    'oasdiff not found; install it with `go install github.com/oasdiff/oasdiff@latest`.',
  );
}

// Only lines that name a change; comments and blank lines are left out.
function acceptedLines() {
  const file = join(root, ACCEPTED);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const inGit = tryGit('rev-parse', '--git-dir') !== undefined;
const base = inGit ? baseline() : undefined;
if (base === undefined) {
  console.log(
    inGit
      ? `api:diff: no baseline (no v* tag, and main has no ${DOCUMENT}); nothing to compare.`
      : 'api:diff: not a git checkout, so no baseline; skipped (run it in the checkout).',
  );
} else {
  const reportOnly = base.reportOnly || reportOnlyFlag;
  const tmp = mkdtempSync(join(tmpdir(), 'multitap-api-diff-'));
  try {
    const baseFile = join(tmp, 'base.json');
    writeFileSync(baseFile, base.doc);
    const accepted = acceptedLines();
    const ignoreFile = join(tmp, 'accepted.txt');
    writeFileSync(ignoreFile, accepted.join('\n') + '\n');
    console.log(
      `api:diff: ${DOCUMENT} against ${base.ref}${reportOnly ? ' (report only)' : ''}` +
        (accepted.length > 0 ? `, ${String(accepted.length)} accepted in ${ACCEPTED}` : ''),
    );
    const status = oasdiff([
      'breaking',
      baseFile,
      join(root, DOCUMENT),
      '--format',
      'text',
      ...(accepted.length > 0 ? ['--err-ignore', ignoreFile] : []),
      ...(reportOnly ? [] : ['--fail-on', 'ERR']),
    ]);
    if (status !== 0 && !reportOnly) {
      console.error(
        `api:diff: breaking /v1 change against ${base.ref}. Make it additive, or accept it on purpose ` +
          `in ${ACCEPTED} (a minor bump and a "Breaking changes" changelog entry).`,
      );
    }
    process.exitCode = reportOnly ? 0 : status;
  } catch (err) {
    if (!(err instanceof OasdiffMissing) || !optional) throw err;
    console.warn(`api:diff: skipped: ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
