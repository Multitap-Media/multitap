/**
 * Writes Multitap's OpenAPI document (phase 1 step 8), with no server or database:
 *
 *   node --conditions=development src/openapi.ts <output.json>
 *
 * `pnpm --filter @multitap/core openapi` writes packages/api/openapi.json, and
 * `pnpm run api:check` compares a fresh copy against the committed one.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApiDocument } from './http/app.ts';

function sortKeys<T extends object>(map: T): T {
  return Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as T;
}

/**
 * The document as committed: paths and component maps sorted by name (so
 * registration order never shows up in diffs), everything else in declaration
 * order, two-space indent and a trailing newline.
 */
export function renderOpenApiDocument(): string {
  const doc = openApiDocument();
  const components =
    doc.components === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(sortKeys(doc.components)).map(([kind, entries]) => [
            kind,
            typeof entries === 'object' && entries !== null ? sortKeys(entries) : entries,
          ]),
        );
  const sorted = {
    ...doc,
    ...(doc.paths === undefined ? {} : { paths: sortKeys(doc.paths) }),
    ...(components === undefined ? {} : { components }),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (import.meta.main) {
  const [output] = process.argv.slice(2);
  if (output === undefined) {
    process.stderr.write('Usage: openapi.ts <output.json>\n');
    process.exitCode = 2;
  } else {
    writeFileSync(resolve(output), renderOpenApiDocument());
  }
}
