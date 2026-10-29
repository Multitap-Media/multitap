// `pnpm run build`: compiles the three packages into their dist/ directories
// the way they are packed and published (okf:process/core-release):
//
// - `tsc -b packages/core` builds core and the packages it references;
// - the declaration files keep the sources' `./x.ts` import specifiers, which a
//   consumer outside the workspace can't resolve, so they are rewritten to
//   `./x.js` (the emitted JavaScript already uses `.js`);
// - hand-written declaration files (`src/*.d.ts`, e.g. `@multitap/api`'s
//   generated `schema.d.ts`) are not emitted by tsc, so they are copied.
//
// Usage: pnpm run build
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const PACKAGES = ['addon-protocol', 'api', 'core'];

const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-b', 'packages/core'], { cwd: root, stdio: 'inherit' });

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

// `from './x.ts'`, `import('./x.ts')` and `from './x.d.ts'`, relative paths only.
const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]*?)(?:\.d)?\.ts\2/g;

let rewritten = 0;
for (const name of PACKAGES) {
  const pkg = join(root, 'packages', name);
  for (const file of files(join(pkg, 'src')).filter((f) => f.endsWith('.d.ts'))) {
    copyFileSync(file, join(pkg, 'dist', file.slice(join(pkg, 'src').length + 1)));
  }
  for (const file of files(join(pkg, 'dist')).filter((f) => f.endsWith('.d.ts'))) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(
      SPECIFIER,
      (_, lead, quote, path) => `${lead}${quote}${path}.js${quote}`,
    );
    if (after !== before) {
      writeFileSync(file, after);
      rewritten += 1;
    }
  }
}
console.log(
  `build: dist/ built for ${PACKAGES.join(', ')}; ${String(rewritten)} declaration file(s) rewritten.`,
);
