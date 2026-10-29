/**
 * Database backups (okf:architecture/core-persistence): `/v1/admin/backups`. A backup is one
 * consistent, verified copy of Multitap's SQLite database. It contains secrets
 * (engine proxy passwords, stored raw streams, hashed API keys): treat it as one.
 */
import { z } from 'zod';

export const BACKUP_KINDS = ['manual', 'scheduled'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/**
 * A backup id: the file name without `.sqlite`, `multitap-<UTC timestamp>` with a
 * `-scheduled` suffix for scheduled backups. Strict, so an id can never name a
 * path outside the backup directory.
 */
export const BACKUP_ID_PATTERN = String.raw`^multitap-\d{8}T\d{9}Z(-scheduled)?$`;

export const BackupIdSchema = z
  .string()
  .regex(new RegExp(BACKUP_ID_PATTERN))
  .meta({ example: 'multitap-20260930T203015123Z' });

export const BackupSchema = z
  .object({
    id: BackupIdSchema,
    createdAt: z.iso.datetime().meta({ example: '2026-09-30T20:30:15.123Z' }),
    sizeBytes: z.number().int().min(0),
    kind: z.enum(BACKUP_KINDS),
  })
  .meta({ id: 'Backup' });
export type Backup = z.infer<typeof BackupSchema>;
