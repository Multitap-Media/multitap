import { globSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources through the
// `development` export condition, so tests never need a build.
const conditions = ['development', 'node', 'import', 'default'];

// One Vitest project per workspace package, each running its own test/ directory.
const packageDirs = globSync('packages/*/package.json')
  .map((file) => dirname(file).replaceAll(sep, '/'))
  .sort();

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    // Multitap's stack tests take one to two seconds alone and can
    // pass 5 s when the whole suite runs in parallel on Windows.
    testTimeout: 15_000,
    projects: packageDirs.map((dir) => ({
      extends: true,
      test: {
        name: dir,
        include: [`${dir}/test/**/*.test.ts`],
      },
    })),
  },
});
