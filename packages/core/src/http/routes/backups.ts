/**
 * `/v1/admin/backups` (okf:architecture/core-persistence): consistent, verified copies of
 * Multitap's database. A backup holds secrets (engine proxy passwords, stored raw
 * streams, hashed API keys): treat the file, and the download, as one.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { BACKUP_ID_PATTERN, BackupSchema } from '@multitap/api';
import { BackupError } from '../../backup/service.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import { backupService } from '../selection-deps.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['admin: backups'];

const IdParams = z.object({
  id: z
    .string()
    .regex(new RegExp(BACKUP_ID_PATTERN))
    .openapi({
      param: { name: 'id', in: 'path' },
      description:
        'The backup id: its file name without `.sqlite` (`multitap-<UTC timestamp>`, with a `-scheduled` suffix for scheduled backups).',
      example: 'multitap-20260930T203015123Z',
    }),
});

/** OpenAPI links (okf:architecture/core-api-testing): create → get, delete; list → get, delete. */
const links = (id: string) => ({
  GetBackup: {
    operationId: 'downloadBackup',
    parameters: { id },
    description: 'Download the backup.',
  },
  DeleteBackup: {
    operationId: 'deleteBackup',
    parameters: { id },
    description: 'Delete the backup.',
  },
});

const noBackup = 'No backup with this id, or the API key is missing, invalid or revoked';

const createBackupRoute = createRoute({
  method: 'post',
  path: '/v1/admin/backups',
  operationId: 'createBackup',
  summary: 'Back up the database now',
  description:
    "Writes one consistent copy of Multitap's database with SQLite's online backup, while Multitap keeps " +
    'serving, checks the copy with `PRAGMA integrity_check`, then prunes the oldest backups beyond ' +
    '`MULTITAP_BACKUP_KEEP`. A backup contains secrets (engine proxy passwords, stored raw streams, hashed ' +
    'API keys): treat it as one.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    201: {
      description: 'The new backup',
      content: { 'application/json': { schema: BackupSchema } },
      links: links('$response.body#/id'),
    },
    409: problemContent('A backup is already running'),
    500: problemContent('The backup failed; older backups are untouched'),
    ...authResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/v1/admin/backups',
  operationId: 'listBackups',
  summary: 'List backups',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'The backups in `MULTITAP_BACKUP_DIR`, newest first',
      content: { 'application/json': { schema: z.array(BackupSchema) } },
      links: links('$response.body#/0/id'),
    },
    ...authResponses,
  },
});

const downloadRoute = createRoute({
  method: 'get',
  path: '/v1/admin/backups/{id}',
  operationId: 'downloadBackup',
  summary: 'Download a backup',
  description:
    'The SQLite file itself, as an attachment. It contains secrets: keep it as private as the database.',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    200: {
      description: 'The backup file',
      headers: z.object({
        'Content-Disposition': z.string(),
        'Content-Length': z.string(),
      }),
      content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
      links: { DeleteBackup: links('$request.path.id').DeleteBackup },
    },
    ...validationResponse,
    403: authResponses[403],
    404: problemContent(noBackup),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/backups/{id}',
  operationId: 'deleteBackup',
  summary: 'Delete a backup',
  tags,
  security: BEARER_SECURITY,
  request: { params: IdParams },
  responses: {
    204: { description: 'Deleted' },
    ...validationResponse,
    403: authResponses[403],
    404: problemContent(noBackup),
  },
});

/** `/v1/admin/backups`. The caller mounts the admin-scope middleware. */
export function registerBackupRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(createBackupRoute, async (c) => {
    try {
      const backup = await backupService(deps).run('manual');
      deps.logger.info({ backupId: backup.id, by: c.get('apiKey').id }, 'backup requested');
      return c.json(backup, 201);
    } catch (err) {
      if (err instanceof BackupError) {
        if (err.code === 'busy') throw new ProblemError(409, err.message);
        throw new ProblemError(500, err.message);
      }
      throw err;
    }
  });

  app.openapi(listRoute, async (c) => c.json(await backupService(deps).list(), 200));

  app.openapi(downloadRoute, async (c) => {
    const { id } = c.req.valid('param');
    const found = await backupService(deps).find(id);
    if (found === undefined) throw new ProblemError(404, 'No backup with this id.');
    deps.logger.info({ backupId: id, by: c.get('apiKey').id }, 'backup downloaded');
    const body = Readable.toWeb(createReadStream(found.path)) as ReadableStream<Uint8Array>;
    return c.body(body, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${id}.sqlite"`,
      'Content-Length': String(found.backup.sizeBytes),
      'Cache-Control': 'no-store',
    });
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    if (!(await backupService(deps).delete(id))) {
      throw new ProblemError(404, 'No backup with this id.');
    }
    return c.body(null, 204);
  });
}
