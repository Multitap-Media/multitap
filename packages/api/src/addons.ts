/**
 * Schemas for Multitap's addon collection (`/v1/admin/addons`, okf:concept/addon-aggregation).
 *
 * An addon's manifest URL is a secret (okf:architecture/secrets-policy): it is accepted when an addon is
 * added and never returned. Every schema here is plain zod without transforms,
 * so it maps one-to-one onto JSON Schema.
 */
import { z } from 'zod';

const timestamp = z.iso.datetime().meta({ example: '2026-09-27T12:00:00.000Z' });

/** A resource the addon serves, with the manifest-wide defaults already applied. */
export const AddonResourceSchema = z
  .object({
    name: z.string().meta({ example: 'stream' }),
    types: z.array(z.string()).meta({ example: ['movie', 'series'] }),
    idPrefixes: z
      .array(z.string())
      .nullable()
      .meta({
        description: '`null` when the addon accepts every id.',
        example: ['tt'],
      }),
  })
  .meta({ id: 'AddonResource' });
export type AddonResource = z.infer<typeof AddonResourceSchema>;

export const AddonCatalogExtraSchema = z
  .object({
    name: z.string().meta({ example: 'search' }),
    isRequired: z.boolean(),
    options: z.array(z.string()),
    optionsLimit: z.number().int().min(0),
  })
  .meta({ id: 'AddonCatalogExtra' });
export type AddonCatalogExtra = z.infer<typeof AddonCatalogExtraSchema>;

export const AddonCatalogSchema = z
  .object({
    type: z.string().meta({ example: 'movie' }),
    id: z.string().meta({ example: 'top' }),
    name: z.string().nullable(),
    extra: z.array(AddonCatalogExtraSchema),
  })
  .meta({ id: 'AddonCatalog' });
export type AddonCatalog = z.infer<typeof AddonCatalogSchema>;

export const AddonRefreshErrorSchema = z
  .object({
    code: z.string().meta({
      description: 'Why the last refresh failed: `timeout`, `network`, `http-status`, …',
      example: 'timeout',
    }),
    at: timestamp,
  })
  .meta({ id: 'AddonRefreshError' });

export const ADDON_STATES = ['ready', 'needs-configuration'] as const;

export const AddonBehaviorHintsSchema = z
  .object({
    configurable: z.boolean().meta({
      description: 'The addon has a configuration page (`/configure`).',
    }),
    configurationRequired: z.boolean().meta({
      description:
        'The addon does nothing until configured. Multitap keeps it installed but does not query it.',
    }),
    adult: z.boolean().meta({ description: 'The addon declares adult content.' }),
    p2p: z.boolean().meta({ description: 'The addon serves torrents (peer-to-peer).' }),
  })
  .meta({ id: 'AddonBehaviorHints' });
export type AddonBehaviorHints = z.infer<typeof AddonBehaviorHintsSchema>;

/** An addon in Multitap's collection. Never includes its manifest URL. */
export const AddonSchema = z
  .object({
    id: z.string().meta({
      description: "Multitap's id for this addon; stable for as long as it's installed.",
      example: '0f8fad5b-d9cb-469f-a165-70867728950e',
    }),
    manifestId: z.string().meta({
      description: "The manifest's own `id`. Two installs of one addon can share it.",
      example: 'com.linvo.cinemeta',
    }),
    name: z.string().meta({ example: 'Cinemeta' }),
    version: z.string().meta({ example: '3.0.14' }),
    description: z.string().nullable(),
    logo: z.string().nullable(),
    host: z.string().meta({
      description: "The manifest URL's hostname; the rest of the URL is secret.",
      example: 'v3-cinemeta.strem.io',
    }),
    types: z.array(z.string()),
    resources: z.array(AddonResourceSchema),
    catalogs: z.array(AddonCatalogSchema),
    behaviorHints: AddonBehaviorHintsSchema,
    state: z.enum(ADDON_STATES).meta({
      description:
        '`needs-configuration`: the manifest says `configurationRequired`. Such an addon is installed but skipped by every aggregated request (reported with status `needs-configuration`). Configure it on its own page, then install the resulting manifest URL.',
    }),
    configurationUrl: z.string().nullable().meta({
      description:
        "The addon's configuration page, `{origin}/configure`, when it is `configurable` or needs configuration; `null` otherwise. Never carries the manifest URL's secret path.",
      example: 'https://torrentio.strem.fun/configure',
    }),
    enabled: z.boolean(),
    position: z.number().int().min(0).meta({ description: 'Collection order; 0 is asked first.' }),
    fetchedAt: timestamp.meta({ description: 'When the cached manifest was last fetched.' }),
    refreshError: AddonRefreshErrorSchema.nullable().meta({
      description:
        'Set when the most recent refresh failed; the last good manifest is kept and used.',
    }),
  })
  .meta({ id: 'Addon' });
export type Addon = z.infer<typeof AddonSchema>;

export const AddAddonSchema = z
  .object({
    manifestUrl: z.string().min(1).max(4096).meta({
      description:
        "The addon's transport URL, ending in `/manifest.json` (`stremio://` is read as `https://`). Secret: never returned.",
      example: 'https://v3-cinemeta.strem.io/manifest.json',
    }),
  })
  .meta({ id: 'AddAddon' });
export type AddAddon = z.infer<typeof AddAddonSchema>;

export const UpdateAddonSchema = z
  .object({ enabled: z.boolean().optional() })
  .meta({ id: 'UpdateAddon' });
export type UpdateAddon = z.infer<typeof UpdateAddonSchema>;

export const ReorderAddonsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(100)).max(1000).meta({
      description: 'Every addon id in the collection, exactly once, in the new order.',
    }),
  })
  .meta({ id: 'ReorderAddons' });
export type ReorderAddons = z.infer<typeof ReorderAddonsSchema>;
