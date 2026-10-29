import { readFileSync } from 'node:fs';

/** `@multitap/core`'s version. `src/` and `dist/` sit at the same depth, so this works from both. */
export const MULTITAP_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
