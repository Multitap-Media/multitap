// `pnpm run ci` (not `pnpm ci`, which is a pnpm built-in): lint, typecheck, the
// stale-document checks, the /v1 breaking-change check against the last v*
// tag (skipped with a warning where oasdiff is not installed), Vitest, the
// packed packages used from outside the workspace (pack:check, needs the npm
// registry), the secrets scan (skipped with a warning where betterleaks is not installed), and
// optionally the contract run.
//
// The contract run needs Linux: it runs by default in a native Linux checkout
// and is skipped elsewhere. `--contract` forces it (on Windows it then runs in
// WSL through scripts/linux-run.sh), `--no-contract` skips it.
//
// The full Linux CI from Windows: `wsl -e bash -lc '<repo>/scripts/linux-run.sh ci'`.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

const root = dirname(import.meta.dirname);
const args = process.argv.slice(2);
const nativeLinux = process.platform === 'linux' && !root.startsWith('/mnt/');
const contract = args.includes('--contract') || (nativeLinux && !args.includes('--no-contract'));

const steps = [
  'lint',
  'typecheck',
  'api:check',
  'api:diff --optional',
  'docs:check',
  'test',
  'pack:check',
  'secrets:scan all --optional',
  ...(contract ? ['contract'] : []),
];
for (const step of steps) {
  console.log(`\nci: ${step}`);
  // On Windows pnpm may be a .cmd shim, which needs a shell; step names are ours.
  const result =
    process.platform === 'win32'
      ? spawnSync(`pnpm run ${step}`, { cwd: root, stdio: 'inherit', shell: true })
      : spawnSync('pnpm', ['run', ...step.split(' ')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`ci: ${step} failed`);
    process.exit(result.status ?? 1);
  }
}
if (!contract) {
  console.log(
    '\nci: contract skipped (Linux only); run `pnpm run contract` or `pnpm run ci --contract`.',
  );
}
console.log('\nci: ok');
