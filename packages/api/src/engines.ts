/** Engine descriptors (okf:concept/engine-descriptor): configuration data used for ranking. */
import { z } from 'zod';

export const ENGINE_TRANSPORTS = ['lan', 'tunnel'] as const;
export type EngineTransport = (typeof ENGINE_TRANSPORTS)[number];

export const HWACCELS = ['qsv', 'nvenc', 'vaapi', 'none'] as const;
export type Hwaccel = (typeof HWACCELS)[number];

/** Lowercase letters, digits and dashes; starts with a letter or digit. */
export const ENGINE_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,62}$';

const height = z.number().int().min(144).max(8640);
const concurrency = z.number().int().min(0).max(64);

export const EngineCapabilitiesSchema = z
  .object({
    hwaccel: z.enum(HWACCELS),
    liveMaxHeight: height.meta({ description: 'Tallest source played live.', example: 1080 }),
    preparedMaxHeight: height.meta({
      description: 'Tallest source played once prepared.',
      example: 2160,
    }),
    tonemap: z.boolean().meta({ description: 'The engine tone maps HDR to SDR.' }),
    sessionOverrides: z.boolean().meta({
      description: 'The engine accepts per-session quality and TTL overrides (upstream #25).',
    }),
    liveConcurrency: concurrency.meta({
      description:
        "Live sessions the engine transcodes at once without stalling. Multitap warns (or, with `MULTITAP_ENGINE_ADMISSION=reject`, refuses) a new session when the engine's resolving and recently playing sessions already reach it.",
      example: 2,
    }),
    prepareConcurrency: concurrency.meta({ example: 1 }),
    defaultBitrate: z.number().int().min(100_000).max(200_000_000).optional().meta({
      description:
        "The engine's own video bitrate in bits per second (server-go's `STREMIO_TRANSCODE_VIDEO_BITRATE`), used when a session sets none. A bitrate Multitap derives from `quality.maxHeight` never exceeds it. Absent = unknown.",
      example: 10_000_000,
    }),
  })
  .meta({ id: 'EngineCapabilities' });
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

const engineFields = {
  name: z.string().trim().min(1).max(100).meta({ example: 'Home' }),
  transport: z.enum(ENGINE_TRANSPORTS),
  address: z
    .string()
    .max(2048)
    .nullable()
    .meta({ description: 'Base URL of the engine, if known.', example: 'http://winbox.lan:11470' }),
  capabilities: EngineCapabilitiesSchema,
  localAddon: z.boolean().meta({ description: 'The engine serves local content.' }),
};

export const EngineDescriptorSchema = z
  .object({
    id: z.string().regex(new RegExp(ENGINE_ID_PATTERN)).meta({ example: 'home' }),
    ...engineFields,
    online: z.boolean().optional().meta({
      description:
        "The engine answered Multitap's last health check. False before the first check. Read-only.",
    }),
    lastSeen: z.iso.datetime().nullable().optional().meta({
      description: 'When the engine last answered a health check; null if never. Read-only.',
      example: '2026-09-30T20:00:00.000Z',
    }),
    proxyPasswordSet: z.boolean().optional().meta({
      description:
        'Multitap holds a proxy password for this engine (`proxyPassword` on PUT). The password itself is never returned. Read-only.',
    }),
  })
  .meta({ id: 'EngineDescriptor' });
export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>;

/** Longest proxy password Multitap accepts. */
export const MAX_PROXY_PASSWORD_LENGTH = 1024;

/** Body of `PUT /v1/admin/engines/{id}`. */
export const EngineInputSchema = z
  .object({
    ...engineFields,
    localAddon: engineFields.localAddon.optional(),
    proxyPassword: z.string().max(MAX_PROXY_PASSWORD_LENGTH).nullable().optional().meta({
      description:
        "Write-only secret: the engine's `STREMIO_PROXY_PASSWORD`, sent as `api_password` on the `/proxy/stream` URLs Multitap builds (sources with `proxyHeaders`). Omitted keeps the stored value; an empty string or null clears it. Never returned: responses carry only `proxyPasswordSet`.",
      writeOnly: true,
    }),
  })
  .meta({ id: 'EngineInput' });
export type EngineInput = z.infer<typeof EngineInputSchema>;
