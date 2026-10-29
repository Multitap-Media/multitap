// Checks that the docs match the code. Plain Node, no dependencies; exits 1 on any finding.
//
//   1. every route in packages/api/openapi.json is in the route table of
//      knowledge/architecture/core-v1-api.md
//   2. every environment variable core reads is in
//      knowledge/architecture/configuration.md
//      and in README.md
//   3. every core migration is mentioned in
//      knowledge/architecture/core-persistence.md
//   4. the version agrees across the three package.json files, openapi.json
//      and the CHANGELOG; the tag v<version> should exist (a warning only)
//   5. relative markdown links resolve to existing files
//   6. every `okf:<id>` reference in a tracked file outside knowledge/ names an
//      existing concept (knowledge/<id>.md)
//
// Usage: pnpm run docs:check
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = dirname(import.meta.dirname);
const read = (path) => readFileSync(join(root, path), 'utf8');
const findings = [];
const warnings = [];
const fail = (check, message) => findings.push(`${check}: ${message}`);

// 1. Routes ----------------------------------------------------------------
{
  const check = 'routes';
  const norm = (path) =>
    path
      .split('?')[0]
      .replace(/\{(\w+)\}/g, ':$1')
      .replace(/:\w+/g, ':')
      .replace(/\/+$/, '');
  const spec = JSON.parse(read('packages/api/openapi.json'));
  const code = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch']) {
      if (item[method]) code.add(`${method.toUpperCase()} ${norm(path)}`);
    }
  }

  // The route table lives in the OKF concept (migrated from the former design document); the frontmatter is dropped so only the body is scanned.
  const routesFile = 'knowledge/architecture/core-v1-api.md';
  const text = existsSync(join(root, routesFile))
    ? read(routesFile).replace(/^---\n[\s\S]*?\n---\n/, '')
    : undefined;
  if (text === undefined) {
    fail(check, `${routesFile} does not exist`);
  } else {
    const documented = new Set();
    const planned = new Set();
    // The prose lists the admin routes by group (`/v1/admin/addons` (list, add,
    // ...)), not one by one, so a group name covers the routes under it.
    const groups = [...text.matchAll(/`(\/v1\/admin\/[a-z-]+)`/g)].map((m) => m[1]);
    const methods = 'GET|POST|PUT|PATCH|DELETE';
    const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    // Prose around the block names more routes as `METHOD /path` in backticks.
    const prose = text.replace(/```[\s\S]*?```/g, '');
    const lines = [...fenced.split('\n'), ...[...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1])];
    // Only core's own routes count: the prose also names engine routes
    // (`GET /opensubHash`), relative admin sub-routes (`POST /preview`) and
    // elisions (`/v1/streams/…`).
    const ours = /^\/(v1\/|metrics$|healthz$|openapi\.json$)/;
    for (const line of lines) {
      // "GET /a/:id · DELETE /a/:id" and "PATCH /a · PUT (all) · DELETE": a bare
      // method after a middle dot repeats the path before it.
      let last;
      const re = new RegExp(String.raw`\b(${methods})\b(?:\s+(/[^\s\u00b7]*))?`, 'g');
      for (const m of line.matchAll(re)) {
        const path = m[2] ?? (/·\s*$/.test(line.slice(0, m.index)) ? last : undefined);
        if (path === undefined || !ours.test(path) || path.includes('…')) continue;
        last = path;
        const key = `${m[1]} ${norm(path)}`;
        documented.add(key);
        if (/\bplanned\b|phase \d/.test(line)) planned.add(key);
      }
    }
    const covered = (key) =>
      documented.has(key) || groups.some((g) => key.split(' ')[1].startsWith(norm(g)));
    for (const key of [...code].filter((k) => !covered(k)).sort()) {
      fail(check, `in openapi.json but not in core-v1-api.md: ${key}`);
    }
    for (const key of [...documented].filter((k) => !code.has(k) && !planned.has(k)).sort()) {
      fail(check, `in core-v1-api.md but not in openapi.json (and not marked planned): ${key}`);
    }
  }
}

// 2. Environment variables -------------------------------------------------
{
  const check = 'env';
  const config = read('packages/core/src/config.ts');
  const schema = config.match(/const EnvSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
  if (!schema) {
    fail(check, 'cannot find EnvSchema in packages/core/src/config.ts');
  } else {
    // Keys of the schema object sit at two spaces of indent; nested lines are deeper.
    const names = [...schema[1].matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    if (names.length < 20)
      fail(check, `only ${String(names.length)} variables found; pattern stale?`);
    // The docs abbreviate families: `A_{X,Y}_MS` and `A_X_MS` / `_Y_MS`.
    const expand = (text) => {
      const out = new Set(text.match(/[A-Z][A-Z0-9_]*[A-Z0-9]/g));
      for (const m of text.matchAll(/([A-Z][A-Z0-9_]*)\{([A-Z0-9_,]+)\}([A-Z0-9_]*)/g)) {
        for (const alt of m[2].split(',')) out.add(m[1] + alt + m[3]);
      }
      const chain = /([A-Z][A-Z0-9_]*[A-Z0-9])`?((?:\s*\/\s*`?_[A-Z0-9_]*[A-Z0-9]`?)+)/g;
      for (const m of text.matchAll(chain)) {
        const base = m[1].split('_');
        for (const suffix of m[2].match(/_[A-Z0-9_]*[A-Z0-9]/g)) {
          const words = suffix.slice(1).split('_');
          // The suffix may share its tail with the base (`_TIMEOUT_MS` on
          // `X_INTERVAL_MS`) or replace more words (`_MAX_BACKOFF_MS`): try each.
          for (let keep = 1; keep < base.length; keep++) {
            out.add([...base.slice(0, keep), ...words].join('_'));
          }
        }
      }
      return out;
    };
    const mentions = (text, name) => expand(text).has(name);
    // The env table lives in the OKF concept (migrated from the former design document); the frontmatter is dropped so only the body is scanned.
    const configFile = 'knowledge/architecture/configuration.md';
    const table = existsSync(join(root, configFile))
      ? read(configFile).replace(/^---\n[\s\S]*?\n---\n/, '')
      : undefined;
    const readme = read('README.md');
    if (table === undefined) fail(check, `${configFile} does not exist`);
    for (const name of names) {
      if (table !== undefined && !mentions(table, name)) {
        fail(check, `${name} is not in ${configFile}`);
      }
      if (!mentions(readme, name)) fail(check, `${name} is not in README.md`);
    }
  }
}

// 3. Migrations ------------------------------------------------------------
{
  const check = 'migrations';
  // The migrations list lives in the OKF concept (migrated from the former design document); the frontmatter is dropped so only the body is scanned.
  const migrationsFile = 'knowledge/architecture/core-persistence.md';
  const text = existsSync(join(root, migrationsFile))
    ? read(migrationsFile).replace(/^---\n[\s\S]*?\n---\n/, '')
    : undefined;
  if (text === undefined) fail(check, `${migrationsFile} does not exist`);
  const files = readdirSync(join(root, 'packages/core/migrations')).filter((f) =>
    /^\d{4}_.*\.ts$/.test(f),
  );
  for (const file of files) {
    const name = file.replace(/\.ts$/, '');
    if (text !== undefined && !text.includes(name))
      fail(check, `${name} is not mentioned in ${migrationsFile}`);
  }
}

// 4. Version ---------------------------------------------------------------
{
  const check = 'version';
  const version = JSON.parse(read('packages/core/package.json')).version;
  for (const pkg of ['packages/api', 'packages/addon-protocol']) {
    const other = JSON.parse(read(`${pkg}/package.json`)).version;
    if (other !== version) fail(check, `${pkg} is ${other}, packages/core is ${version}`);
  }
  const spec = JSON.parse(read('packages/api/openapi.json')).info?.version;
  if (spec !== version) {
    fail(check, `openapi.json info.version is ${String(spec)}, core is ${version}`);
  }
  const top = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)\b/m)?.[1];
  if (top !== version) fail(check, `top CHANGELOG release is ${String(top)}, core is ${version}`);
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const clean = git('status', '--porcelain') === '';
    const tags = git('tag', '--list', `v${version}`);
    if (clean && tags === '') warnings.push(`version: tag v${version} does not exist yet`);
  } catch {
    warnings.push('version: git is unavailable; tag not checked');
  }
}

// 5. Relative markdown links -----------------------------------------------
{
  const check = 'links';
  const markdown = (dir, deep) => {
    const out = [];
    const base = join(root, dir);
    if (!existsSync(base)) return out;
    for (const entry of readdirSync(base)) {
      if (statSync(join(base, entry)).isDirectory()) {
        if (deep) out.push(...markdown(join(dir, entry), deep));
      } else if (entry.endsWith('.md')) {
        out.push(join(dir, entry));
      }
    }
    return out;
  };
  // The root documents and the agent skills; `okf validate` checks the
  // knowledge/ bundle's own links.
  const files = [...markdown('.', false), ...markdown('.claude/skills', true)];
  for (const file of files) {
    // Code spans and fenced blocks hold examples, not links.
    const text = read(file)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      // `file.ts:123` points at a line.
      const path = decodeURIComponent(target.split('#')[0]).replace(/:\d+(-\d+)?$/, '');
      if (path === '') continue;
      const resolved = resolve(root, dirname(file), path);
      if (!existsSync(resolved)) {
        fail(check, `${file}: ${target} does not exist (${relative(root, resolved)})`);
      }
    }
  }
}

// 6. OKF references --------------------------------------------------------
{
  const check = 'okf-refs';
  // Outside a git checkout (scripts/linux-run.sh copies the tree without .git),
  // every file but dependencies and build output.
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (!entry.isDirectory()) return [path];
      return ['node_modules', 'dist', '.git'].includes(entry.name) ? [] : walk(path);
    });
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0');
  } catch {
    listed = walk('');
  }
  const tracked = listed.filter((f) => f !== '' && existsSync(join(root, f)));
  const textFile =
    /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|sql|css|html|txt)$|(^|\/)(Dockerfile[^/]*|Makefile)$/;
  const refPattern = /\bokf:([a-z0-9][a-z0-9/_-]*[a-z0-9])/g;
  let validated = 0;
  for (const file of tracked) {
    if (!textFile.test(file) || file.startsWith('knowledge/')) continue;
    const text = read(file);
    for (const m of text.matchAll(refPattern)) {
      validated += 1;
      if (!existsSync(join(root, 'knowledge', `${m[1]}.md`))) {
        fail(check, `${file}: okf:${m[1]} has no concept knowledge/${m[1]}.md`);
      }
    }
  }
  console.log(`docs:check: ${String(validated)} okf: reference(s) checked.`);
}

for (const warning of warnings) console.warn(`docs:check warning: ${warning}`);
if (findings.length > 0) {
  for (const finding of findings) console.error(`docs:check: ${finding}`);
  console.error(`docs:check: ${String(findings.length)} finding(s).`);
  process.exitCode = 1;
} else {
  console.log('docs:check: routes, env, migrations, version and links agree.');
}
