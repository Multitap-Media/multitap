import {
  isResourceSupported,
  resourceName,
  type ExtraProp,
  type Manifest,
  type ResourcePathInput,
} from '@multitap/addon-protocol';

/** A manifest resource with the manifest-wide `types` / `idPrefixes` applied to the short form. */
export interface NormalizedResource {
  name: string;
  types: string[];
  /** `undefined` accepts every id. */
  idPrefixes: string[] | undefined;
}

export function normalizedResources(manifest: Manifest): NormalizedResource[] {
  return manifest.resources.map((resource) =>
    typeof resource === 'string'
      ? { name: resource, types: manifest.types, idPrefixes: manifest.idPrefixes }
      : {
          name: resource.name,
          types: resource.types ?? [],
          idPrefixes: resource.idPrefixes,
        },
  );
}

/** Anything the index can route to: an addon id, its manifest, and whether it's enabled. */
export interface Routable {
  id: string;
  enabled: boolean;
  manifest: Manifest;
}

/** A catalog one enabled addon offers, in collection order (step 7's `CatalogRef`). */
export interface CatalogEntry {
  addonId: string;
  addonName: string;
  type: string;
  id: string;
  name: string | undefined;
  extra: ExtraProp[];
}

/**
 * The capability index (okf:concept/addon-aggregation): which enabled addons to ask for a request.
 * Built once per collection change from each manifest's resources, types,
 * `idPrefixes` and catalog extras; the final check per addon is stremio-core's
 * own rule ({@link isResourceSupported}).
 */
export class CapabilityIndex<T extends Routable> {
  /** Enabled addons by resource name, in collection order. */
  readonly #byResource = new Map<string, T[]>();
  /** Enabled addons with at least one catalog / addon catalog. */
  readonly #withCatalogs: T[] = [];
  readonly #withAddonCatalogs: T[] = [];
  readonly #catalogs: CatalogEntry[] = [];

  /** `addons` must already be in collection order. */
  constructor(addons: readonly T[]) {
    for (const addon of addons) {
      if (!addon.enabled) continue;
      for (const name of new Set(addon.manifest.resources.map(resourceName))) {
        const list = this.#byResource.get(name) ?? [];
        list.push(addon);
        this.#byResource.set(name, list);
      }
      if (addon.manifest.catalogs.length > 0) this.#withCatalogs.push(addon);
      if (addon.manifest.addonCatalogs.length > 0) this.#withAddonCatalogs.push(addon);
      for (const catalog of addon.manifest.catalogs) {
        this.#catalogs.push({
          addonId: addon.id,
          addonName: addon.manifest.name,
          type: catalog.type,
          id: catalog.id,
          name: catalog.name,
          extra: catalog.extra,
        });
      }
    }
  }

  /** The enabled addons that support `path`, in collection order. */
  match(path: ResourcePathInput): T[] {
    let candidates: readonly T[];
    if (path.resource === 'catalog') candidates = this.#withCatalogs;
    else if (path.resource === 'addon_catalog') candidates = this.#withAddonCatalogs;
    else candidates = this.#byResource.get(path.resource) ?? [];
    return candidates.filter((addon) => isResourceSupported(addon.manifest, path));
  }

  /** Every catalog of every enabled addon, in collection order. */
  catalogs(): readonly CatalogEntry[] {
    return this.#catalogs;
  }
}
