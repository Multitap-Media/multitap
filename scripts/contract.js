// `pnpm run contract`: Schemathesis against Multitap (packages/core/test/contract/run.ts).
//
// It runs in Linux only, from a native checkout with its own node_modules:
// - In a native Linux checkout (e.g. WSL's ~/multitap-ci), the harness runs here.
// - On Windows, or in WSL over /mnt/c, scripts/linux-run.sh copies the working
//   tree into WSL, installs there and runs `pnpm run contract` in the copy.
//
// Other arguments are passed to the harness: --seed N, --max-examples N,
// --pass <read|client|admin>, and `-- <schemathesis args>`.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
// `pnpm run contract -- --seed 1` passes the `--` through; drop it.
const args = process.argv.slice(process.argv[2] === '--' ? 3 : 2);

const toWsl = (path) =>
  path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');
const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;

let result;
if (process.platform === 'win32') {
  const command = [toWsl(join(root, 'scripts/linux-run.sh')), 'contract', ...args].map(quote);
  result = spawnSync('wsl', ['-e', 'bash', '-lc', command.join(' ')], { stdio: 'inherit' });
} else if (root.startsWith('/mnt/')) {
  result = spawnSync('bash', [join(root, 'scripts/linux-run.sh'), 'contract', ...args], {
    stdio: 'inherit',
  });
} else {
  result = spawnSync(
    process.execPath,
    ['--conditions=development', 'test/contract/run.ts', ...args],
    { cwd: join(root, 'packages/core'), stdio: 'inherit' },
  );
}
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
