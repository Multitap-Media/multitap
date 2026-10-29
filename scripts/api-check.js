// Fails when the committed OpenAPI document or generated client is stale
// (okf:architecture/core-api-testing). Regenerates both into a temporary directory, exactly as
// `pnpm --filter @multitap/core openapi` and `pnpm --filter @multitap/api generate`
// do, and compares them byte for byte with packages/api/.
//
// Usage: pnpm run api:check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const coreApi = join(root, 'packages/api');
const tmp = mkdtempSync(join(tmpdir(), 'multitap-api-check-'));

const run = (args, cwd) => {
  execFileSync(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
};

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const stale = [];
try {
  const doc = join(tmp, 'openapi.json');
  const schema = join(tmp, 'schema.d.ts');
  run(['--conditions=development', 'src/openapi.ts', doc], join(root, 'packages/core'));
  // The client is generated from the fresh document, not the committed one.
  run(['node_modules/openapi-typescript/bin/cli.js', doc, '-o', schema], coreApi);

  const pairs = [
    ['packages/api/openapi.json', doc],
    ['packages/api/src/schema.d.ts', schema],
  ];
  stale.push(...pairs.filter(([committed, fresh]) => read(join(root, committed)) !== read(fresh)));
  for (const [committed] of stale) {
    console.error(
      `api:check: ${committed} is stale; run \`pnpm run api:generate\` and commit the result.`,
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (stale.length > 0) {
  process.exitCode = 1;
} else {
  console.log('api:check: openapi.json and schema.d.ts are current.');
}
