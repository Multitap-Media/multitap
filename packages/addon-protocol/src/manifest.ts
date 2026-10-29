/**
 * Addon manifests. Ported from stremio-core's `types/addon/manifest.rs` and
 * `types/addon/descriptor.rs`.
 */
import { z } from 'zod';
import { lenientUrl, optional, u64, urlString } from './common.ts';
import type { ExtraValue, ResourcePathInput } from './request.ts';

// semver 2.0.0 (https://semver.org), which the `semver` crate enforces.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** An extra property a catalog accepts (`search`, `genre`, `skip`, …). */
export const ExtraPropSchema = z.looseObject({
  name: z.string(),
  isRequired: z.boolean().default(false),
  options: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  /** The maximum number of values to pass for this property. */
  optionsLimit: u64.default(1),
});
export type ExtraProp = z.output<typeof ExtraPropSchema>;

/** stremio-core replaces any declared `skip` prop with this canonical one (`SKIP_EXTRA_PROP`). */
const SKIP_EXTRA_PROP: ExtraProp = {
  name: 'skip',
  isRequired: false,
  options: [],
  optionsLimit: 1,
};

/** The first item per key wins, like stremio-core's `UniqueVec`. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const fullExtra = z.array(ExtraPropSchema);
const shortExtraNames = z.array(z.string()).default(() => []);

/**
 * `ManifestExtra`, an untagged enum tried in order:
 * 1. `Full`: an `extra` array of props (deduplicated by name, `skip` canonicalized).
 * 2. `Short`: the legacy `extraSupported` / `extraRequired` name lists. Each
 *    supported name becomes a prop, required if it's also in `extraRequired`.
 *
 * Returns `undefined` if neither form parses.
 */
function parseManifestExtra(catalog: {
  extra?: unknown;
  extraRequired?: unknown;
  extraSupported?: unknown;
}): ExtraProp[] | undefined {
  const full = fullExtra.safeParse(catalog.extra);
  if (full.success) {
    return uniqueBy(full.data, (prop) => prop.name).map((prop) =>
      prop.name === SKIP_EXTRA_PROP.name ? { ...SKIP_EXTRA_PROP } : prop,
    );
  }
  const required = shortExtraNames.safeParse(catalog.extraRequired);
  const supported = shortExtraNames.safeParse(catalog.extraSupported);
  if (!required.success || !supported.success) return undefined;
  const requiredNames = uniqueBy(required.data, (name) => name);
  return uniqueBy(supported.data, (name) => name).map((name) => ({
    name,
    isRequired: requiredNames.includes(name),
    options: [],
    optionsLimit: 1,
  }));
}

/**
 * A catalog in a manifest. On output, `extra` always holds the normalized props,
 * whichever form the addon used; `extraSupported` / `extraRequired` are kept as
 * sent.
 */
export const ManifestCatalogSchema = z
  .looseObject({
    id: z.string(),
    type: z.string(),
    name: optional(z.string()),
    extra: z.unknown().optional(),
    extraRequired: z.unknown().optional(),
    extraSupported: z.unknown().optional(),
  })
  .transform((catalog, ctx) => {
    const extra = parseManifestExtra(catalog);
    if (extra === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Invalid catalog extra: expected an `extra` array or `extraSupported`/`extraRequired` name lists',
        path: ['extra'],
      });
      return z.NEVER;
    }
    return { ...catalog, extra };
  });
export type ManifestCatalog = z.output<typeof ManifestCatalogSchema>;

/**
 * A resource the addon provides: the short form (`"stream"`) or the full form
 * with its own `types` and `idPrefixes`.
 */
export const ManifestResourceSchema = z.union([
  z.string(),
  z.looseObject({
    name: z.string(),
    types: optional(z.array(z.string())),
    idPrefixes: optional(z.array(z.string())),
  }),
]);
export type ManifestResource = z.output<typeof ManifestResourceSchema>;

export const ManifestBehaviorHintsSchema = z.looseObject({
  adult: z.boolean().default(false),
  p2p: z.boolean().default(false),
  configurable: z.boolean().default(false),
  configurationRequired: z.boolean().default(false),
  epgProvider: z.boolean().default(false),
});
export type ManifestBehaviorHints = z.output<typeof ManifestBehaviorHintsSchema>;

const catalogList = z
  .array(ManifestCatalogSchema)
  .default(() => [])
  .transform((catalogs) => uniqueBy(catalogs, (c) => `${c.id}\u0000${c.type}`));

export const ManifestSchema = z.looseObject({
  id: z.string(),
  version: z.string().regex(SEMVER, 'Invalid semver version'),
  name: z.string(),
  contactEmail: optional(z.string()),
  description: optional(z.string()),
  logo: lenientUrl,
  background: lenientUrl,
  /** Globally supported types. An empty list supports none. */
  types: z.array(z.string()),
  resources: z.array(ManifestResourceSchema),
  /** Globally supported id prefixes. `undefined` supports every id. */
  idPrefixes: optional(z.array(z.string())),
  /** Deduplicated by `(id, type)`, first wins. */
  catalogs: catalogList,
  addonCatalogs: catalogList,
  behaviorHints: ManifestBehaviorHintsSchema.default(() => ManifestBehaviorHintsSchema.parse({})),
});
export type Manifest = z.output<typeof ManifestSchema>;

/** An installed addon: its manifest and where it's served from. */
export const DescriptorSchema = z.looseObject({
  manifest: ManifestSchema,
  transportUrl: urlString,
  flags: z
    .looseObject({
      official: z.boolean().default(false),
      protected: z.boolean().default(false),
    })
    .default(() => ({ official: false, protected: false })),
});
export type Descriptor = z.output<typeof DescriptorSchema>;

/** The name of a manifest resource in either form. */
export function resourceName(resource: ManifestResource): string {
  return typeof resource === 'string' ? resource : resource.name;
}

/**
 * `ManifestCatalog::is_extra_supported`: every given extra is declared, and
 * every required prop is given.
 */
export function isExtraSupported(
  catalog: Pick<ManifestCatalog, 'extra'>,
  extra: readonly ExtraValue[],
): boolean {
  const allSupported = extra.every((value) =>
    catalog.extra.some((prop) => prop.name === value.name),
  );
  const requiredSatisfied = catalog.extra
    .filter((prop) => prop.isRequired)
    .every((prop) => extra.some((value) => value.name === prop.name));
  return allSupported && requiredSatisfied;
}

/**
 * `Manifest::is_resource_supported`: whether an addon should be asked for a
 * resource path.
 * - `catalog` / `addon_catalog`: a catalog with that type and id accepts the extra.
 * - anything else: the resource is declared, its types (the manifest's for the
 *   short form) include the type, and its id prefixes (the manifest's for the
 *   short form) are unset, empty, or match the id.
 */
export function isResourceSupported(
  manifest: Pick<Manifest, 'catalogs' | 'addonCatalogs' | 'resources' | 'types' | 'idPrefixes'>,
  path: ResourcePathInput,
): boolean {
  const extra = path.extra ?? [];
  if (path.resource === 'catalog' || path.resource === 'addon_catalog') {
    const catalogs = path.resource === 'catalog' ? manifest.catalogs : manifest.addonCatalogs;
    return catalogs.some(
      (catalog) =>
        catalog.type === path.type && catalog.id === path.id && isExtraSupported(catalog, extra),
    );
  }
  const resource = manifest.resources.find((r) => resourceName(r) === path.resource);
  if (resource === undefined) return false;
  const types = typeof resource === 'string' ? manifest.types : resource.types;
  const idPrefixes = typeof resource === 'string' ? manifest.idPrefixes : resource.idPrefixes;
  const typeSupported = types?.includes(path.type) ?? false;
  const idSupported =
    idPrefixes === undefined ||
    idPrefixes.length === 0 ||
    idPrefixes.some((prefix) => path.id.startsWith(prefix));
  return typeSupported && idSupported;
}
