import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { destination } from 'pino';
import {
  API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRecord,
  type ApiKeyScope,
  type Clock,
} from './auth/keys.ts';
import { backupBeforeMigrating } from './backup/service.ts';
import { ConfigError, loadConfig } from './config.ts';
import { MAX_PROXY_PASSWORD_LENGTH } from '@multitap/api';
import { DB_FILE, migrateToLatest, openDatabase, type Db } from './db/index.ts';
import { createLogger } from './log.ts';

/**
 * Multitap's admin CLI (okf:architecture/core-api-keys-security), run as `node dist/cli.js …` (or with
 * `--conditions=development src/cli.ts` in dev). Uses the same `MULTITAP_DATA_DIR`,
 * database and migrations as the server, so it works whether or not Multitap is
 * running.
 */

const USAGE = `Usage:
  multitap api-key create --scope client|admin|metrics --label <label> [--json]
  multitap api-key list [--json]
  multitap api-key revoke <id> [--json]
  multitap engine proxy-password <engineId> --file <path>
  multitap engine proxy-password <engineId> --clear
`;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock?: Clock;
  /** Reads a password file (a test seam); one trailing newline is dropped. */
  readFile?: (path: string) => string;
  /** The effective user id (a test seam); default `process.geteuid()`, `null` where there is none (Windows). */
  uid?: number | null;
}

class UsageError extends Error {}

const iso = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString());

function toJson(record: ApiKeyRecord) {
  return {
    id: record.id,
    scope: record.scope,
    label: record.label,
    createdAt: new Date(record.createdAt).toISOString(),
    lastUsed: record.lastUsed === null ? null : new Date(record.lastUsed).toISOString(),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
  };
}

function table(records: ApiKeyRecord[]): string {
  const rows = [
    ['ID', 'SCOPE', 'LABEL', 'CREATED', 'LAST USED', 'REVOKED'],
    ...records.map((r) => [
      r.id,
      r.scope,
      r.label,
      iso(r.createdAt),
      iso(r.lastUsed),
      iso(r.revokedAt),
    ]),
  ];
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

async function apiKeyCommand(db: Db, args: string[], io: CliIo, clock: Clock): Promise<number> {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      scope: { type: 'string' },
      label: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  switch (action) {
    case 'create': {
      const scope = values.scope;
      const label = values.label?.trim();
      if (!API_KEY_SCOPES.includes(scope as ApiKeyScope)) {
        throw new UsageError('--scope must be client, admin or metrics');
      }
      if (!label || label.length > 100) throw new UsageError('--label must be 1 to 100 characters');
      if (positionals.length > 0)
        throw new UsageError(`unexpected argument: ${positionals.join(' ')}`);
      const created = await createApiKey(db, { scope: scope as ApiKeyScope, label }, clock);
      if (values.json) {
        io.stdout(`${JSON.stringify({ ...toJson(created), key: created.key })}\n`);
      } else {
        io.stdout(
          `Created ${created.scope} key ${created.id} (${created.label}).\n` +
            `This is the only time the key is shown:\n\n${created.key}\n`,
        );
      }
      return 0;
    }
    case 'list': {
      if (positionals.length > 0)
        throw new UsageError(`unexpected argument: ${positionals.join(' ')}`);
      const keys = await listApiKeys(db);
      io.stdout(
        values.json
          ? `${JSON.stringify(keys.map(toJson))}\n`
          : keys.length === 0
            ? 'No API keys.\n'
            : `${table(keys)}\n`,
      );
      return 0;
    }
    case 'revoke': {
      const [id, ...extra] = positionals;
      if (!id || extra.length > 0) throw new UsageError('revoke takes exactly one key id');
      const revoked = await revokeApiKey(db, id, clock);
      if (!revoked) {
        io.stderr(`No API key with id ${id}.\n`);
        return 1;
      }
      io.stdout(
        values.json
          ? `${JSON.stringify(toJson(revoked))}\n`
          : `Revoked key ${revoked.id} (${revoked.label}) at ${iso(revoked.revokedAt)}.\n`,
      );
      return 0;
    }
    default:
      throw new UsageError(
        action ? `unknown api-key command: ${action}` : 'missing api-key command',
      );
  }
}

/**
 * `engine proxy-password`: sets or clears an engine's proxy password (okf:architecture/secrets-classes-and-engine-password)
 * from a file, so it never appears on a command line or in shell history.
 * Takes effect on the next engine request; Multitap needn't restart.
 */
async function engineCommand(db: Db, args: string[], io: CliIo): Promise<number> {
  const [action, ...rest] = args;
  if (action !== 'proxy-password') {
    throw new UsageError(action ? `unknown engine command: ${action}` : 'missing engine command');
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: { file: { type: 'string' }, clear: { type: 'boolean', default: false } },
  });
  const [id, ...extra] = positionals;
  if (!id || extra.length > 0) throw new UsageError('proxy-password takes exactly one engine id');
  if ((values.file === undefined) === !values.clear) {
    throw new UsageError('give either --file <path> or --clear');
  }
  let password: string | null = null;
  if (values.file !== undefined) {
    const read =
      io.readFile ?? ((path: string) => readFileSync(path, 'utf8').replace(/\r?\n$/, ''));
    try {
      password = read(resolve(values.file));
    } catch {
      io.stderr('Could not read the password file.\n');
      return 1;
    }
    if (password === '' || password.length > MAX_PROXY_PASSWORD_LENGTH) {
      io.stderr(
        `The password file must hold 1 to ${String(MAX_PROXY_PASSWORD_LENGTH)} characters.\n`,
      );
      return 1;
    }
  }
  const result = await db
    .updateTable('engines')
    .set({ proxy_password: password })
    .where('id', '=', id)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    io.stderr(`No engine with id ${id}.\n`);
    return 1;
  }
  io.stdout(
    password === null
      ? `Cleared the proxy password of engine ${id}.\n`
      : `Set the proxy password of engine ${id}.\n`,
  );
  return 0;
}

/**
 * Why the CLI won't run as root, or `undefined`: running it with `sudo` on a
 * bare host where the data folder (or the backup folder) belongs to the
 * service user would leave root-owned files there (the database's `-wal` and
 * `-shm`, a backup before migrating in a 0700 folder) that Multitap, running
 * as that user, then can't open, so it refuses to start. Root may still run
 * it on folders root owns (a container's own user, a root service).
 */
function rootRefusal(uid: number, config: { dataDir: string; backup: { dir: string } }) {
  if (uid !== 0) return undefined;
  for (const dir of [config.dataDir, config.backup.dir]) {
    let owner: number;
    try {
      owner = statSync(dir).uid;
    } catch {
      continue; // Not there yet.
    }
    if (owner !== 0) {
      return (
        `Refusing to run as root: ${dir} belongs to user ${String(owner)}, and files the CLI ` +
        'writes there (the database journal, a backup before migrating) would belong to root, ' +
        `which Multitap running as that user can't open. Run it as that user instead, for ` +
        `example: sudo -u '#${String(owner)}' multitap …\n`
      );
    }
  }
  return undefined;
}

/** Runs the CLI and returns its exit code: 0 ok, 1 failure, 2 usage error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, ...rest] = argv;
  if (group === undefined || group === '--help' || group === '-h' || group === 'help') {
    io.stdout(USAGE);
    return group === undefined ? 2 : 0;
  }

  let config;
  try {
    config = loadConfig(io.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Logs (migrations, errors) go to stderr so stdout stays clean for the key.
  const verbose = config.logLevel === 'debug' || config.logLevel === 'trace';
  const logger = createLogger({
    level: verbose ? config.logLevel : 'warn',
    destination: destination({ dest: 2, sync: true }),
  });

  // POSIX only: Windows has no user ids (geteuid is undefined there).
  const uid = io.uid === undefined ? (process.geteuid?.() ?? null) : io.uid;
  const refusal = uid === null ? undefined : rootRefusal(uid, config);
  if (refusal !== undefined) {
    io.stderr(refusal);
    return 1;
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(config.dataDir, DB_FILE));
  try {
    // The CLI may be the first to open the database after an upgrade, so it
    // backs up before migrating just as Multitap does.
    await migrateToLatest(db, logger, {
      beforeMigrating: (pending) =>
        backupBeforeMigrating(
          { db, logger, clock: io.clock ?? Date.now, backupDir: config.backup.dir },
          pending,
        ),
    });
    if (group === 'engine') return await engineCommand(db, rest, io);
    if (group !== 'api-key') throw new UsageError(`unknown command: ${group}`);
    return await apiKeyCommand(db, rest, io, io.clock ?? Date.now);
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && 'code' in err)) {
      // TypeError with a code: parseArgs rejecting an option.
      io.stderr(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
