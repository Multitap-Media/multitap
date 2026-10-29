/**
 * `/v1` browse routes (okf:architecture/core-v1-api, phase 1 step 7): catalogs, a
 * catalog, meta, the source list and subtitles. Client scope.
 *
 * Per request only the route pattern and counts are logged: ids, search terms
 * and anything URL-like stay out of the logs (okf:architecture/secrets-policy).
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CatalogPageSchema,
  CatalogRefSchema,
  ENGINE_ID_PATTERN,
  HIGH_RES_POLICIES,
  MAX_BINGE_GROUP_LENGTH,
  MAX_PREFERRED_LANGUAGES,
  MetaResultSchema,
  SearchResultSchema,
  SOURCE_ORDERS,
  SourceListSchema,
  SourceListStartedSchema,
  SubtitleListSchema,
  type AddonStatus,
  type CatalogRef,
  type SearchSource,
} from '@multitap/api';
import type { ExtraProp, ExtraValue, ManifestCatalog } from '@multitap/addon-protocol';
import { addonStatus, type CatalogEntry } from '../../addons/index.ts';
import { metaDetailView, metaPreviewView } from '../../addons/meta-view.ts';
import { defaultEngineId, getEngine, NoDefaultEngineError } from '../../engines/index.ts';
import { randomIds } from '../../lib/ids.ts';
import { resolvePreferredLanguages, startSourceList, sortByRank } from '../../selection/index.ts';
import { SubtitleFileError } from '../../subtitles/index.ts';
import { authResponses, BEARER_SECURITY } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import { itemMetaLookup, profileSelection, rankingStore } from '../selection-deps.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['browse'];

const typeParam = z
  .string()
  .min(1)
  .max(64)
  .openapi({
    param: { name: 'type', in: 'path' },
    description: 'Content type: `movie`, `series`, `channel`, `tv`, …',
    example: 'movie',
  });

const itemIdParam = (name: string, description: string, example: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .openapi({ param: { name, in: 'path' }, description, example });

const badRequest = (description: string) => ({ 400: problemContent(description) });

const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

// ---- Catalogs ----------------------------------------------------------------

const catalogsRoute = createRoute({
  method: 'get',
  path: '/v1/catalogs',
  operationId: 'listCatalogs',
  summary: 'List the catalogs of the enabled addons',
  description: 'In collection order, each addon in its manifest order.',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: json('Every catalog', z.array(CatalogRefSchema)),
    ...authResponses,
  },
});

const catalogRoute = createRoute({
  method: 'get',
  path: '/v1/catalog/{addonId}/{type}/{id}',
  operationId: 'getCatalog',
  summary: "One page of an addon's catalog",
  description:
    "Extras are query parameters, checked against the catalog's declared `extra`: `search`, `skip` and `genre` are the " +
    'common ones, and any other declared extra (e.g. `lastVideosIds`) is passed the same way; repeat a parameter ' +
    'for several values, up to its `optionsLimit`. An undeclared extra, a value outside `options`, or a missing ' +
    'required extra is a 400. An addon that fails still gets a 200, with its status in `addon`.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      addonId: z
        .string()
        .min(1)
        .max(100)
        .openapi({ param: { name: 'addonId', in: 'path' }, description: "Multitap's addon id." }),
      type: typeParam,
      id: itemIdParam('id', "The catalog's id in the addon's manifest.", 'top'),
    }),
    query: z.object({
      search: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .openapi({ param: { name: 'search', in: 'query' }, example: 'dune' }),
      skip: z
        .string()
        .regex(/^\d{1,9}$/)
        .optional()
        .openapi({
          param: { name: 'skip', in: 'query' },
          description: 'Items to skip, for paging.',
          example: '100',
        }),
      genre: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .openapi({ param: { name: 'genre', in: 'query' }, example: 'Horror' }),
    }),
  },
  responses: {
    200: json("The addon's items and status", CatalogPageSchema),
    ...badRequest('The request failed validation, or its extras do not fit the catalog'),
    403: authResponses[403],
    404: problemContent(
      'No enabled addon with this id offers this catalog, or the API key is missing, invalid or revoked',
    ),
  },
});

// ---- Search ------------------------------------------------------------------------

const SEARCH_MAX_TYPES = 16;

const searchRoute = createRoute({
  method: 'get',
  path: '/v1/search',
  operationId: 'search',
  summary: 'Search every search-capable catalog',
  description:
    'Asks every enabled addon catalog that declares the `search` extra, all at once, through the same ' +
    'aggregation as the other browse routes (timeouts, circuit breaker, response cache). A catalog that also ' +
    'requires another extra (e.g. `genre`) is not searched, as in Stremio. Results are grouped per catalog, ' +
    "in collection order, each with its addon's status: a failing addon is reported, never fatal. " +
    '`skip` pages every catalog that declares `skip` (the others only answer `skip=0`); for the next page ask ' +
    'again with `skip` plus the page length. `type`/`types` limit the content types searched.',
  tags,
  security: BEARER_SECURITY,
  request: {
    query: z.object({
      q: z
        .string()
        .min(1)
        .max(500)
        .openapi({
          param: { name: 'q', in: 'query' },
          description: 'The search text.',
          example: 'dune',
        }),
      type: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .openapi({
          param: { name: 'type', in: 'query' },
          description: 'Only search catalogs of this content type.',
          example: 'movie',
        }),
      types: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .openapi({
          param: { name: 'types', in: 'query' },
          description: 'Only search catalogs of these content types, comma-separated.',
          example: 'movie,series',
        }),
      skip: z
        .string()
        .regex(/^\d{1,9}$/)
        .optional()
        .openapi({
          param: { name: 'skip', in: 'query' },
          description: 'Items to skip in every catalog, for paging. Default 0.',
          example: '100',
        }),
    }),
  },
  responses: {
    200: json('The results per catalog', SearchResultSchema),
    ...badRequest('The request failed validation'),
    ...authResponses,
  },
});

/**
 * The catalogs a search covers, with the extras to ask them for: those that
 * declare `search`, need nothing else, and (for `skip` > 0) declare `skip`.
 * Stremio's rule (`catalogs_with_extra`).
 */
export function searchTargets(
  catalogs: readonly CatalogEntry[],
  query: string,
  skip: number,
  types: ReadonlySet<string> | undefined,
): { entry: CatalogEntry; extra: ExtraValue[] }[] {
  const out: { entry: CatalogEntry; extra: ExtraValue[] }[] = [];
  for (const entry of catalogs) {
    if (types !== undefined && !types.has(entry.type)) continue;
    if (!entry.extra.some((prop) => prop.name === 'search')) continue;
    if (
      entry.extra.some((prop) => prop.isRequired && prop.name !== 'search' && prop.name !== 'skip')
    ) {
      continue;
    }
    const hasSkip = entry.extra.some((prop) => prop.name === 'skip');
    if (skip > 0 && !hasSkip) continue;
    try {
      const params: Record<string, string[]> = { search: [query] };
      if (skip > 0) params.skip = [String(skip)];
      out.push({ entry, extra: catalogExtras(entry, params) });
    } catch {
      // The catalog restricts `search` in a way free text can't meet.
    }
  }
  return out;
}

// ---- Meta ------------------------------------------------------------------------

const metaRoute = createRoute({
  method: 'get',
  path: '/v1/meta/{type}/{id}',
  operationId: 'getMeta',
  summary: 'Details of an item',
  description:
    'Every addon that serves meta for the type and id is asked; the first one in collection order that answers ' +
    'with a meta wins, as in Stremio.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: z.object({ type: typeParam, id: itemIdParam('id', 'Item id.', 'tt1375666') }),
  },
  responses: {
    200: json('The meta and every addon asked', MetaResultSchema),
    ...badRequest('The request failed validation'),
    403: authResponses[403],
    404: problemContent(
      'No addon returned a meta for this item, or the API key is missing, invalid or revoked',
    ),
  },
});

// ---- Streams ----------------------------------------------------------------------

/** `preferredLanguage` in a query: up to `MAX_PREFERRED_LANGUAGES` three-letter codes, comma-separated. */
const PREFERRED_LANGUAGE_QUERY = new RegExp(
  `^[a-z]{3}(,[a-z]{3}){0,${String(MAX_PREFERRED_LANGUAGES - 1)}}$`,
);

const streamsRoute = createRoute({
  method: 'get',
  path: '/v1/streams/{type}/{videoId}',
  operationId: 'listSources',
  summary: 'The source list for a video',
  description:
    'Every stream every matching addon returned, as candidates annotated for an engine. ' +
    "`sort=addon` (default) keeps collection order and each addon's own order; `sort=rank` orders playable " +
    'candidates first, then by score. Nothing is hidden. Answers once every addon has answered or timed out. ' +
    "With `incremental=true` it answers `202` at once with a request id, and each addon's candidates follow " +
    'as a `streams.partial` event (`GET /v1/events?request={requestId}`), in answer order, the last with ' +
    "`remaining: 0`; `sort=rank` then orders each event's candidates.",
  tags,
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      type: typeParam,
      videoId: itemIdParam(
        'videoId',
        'Video id: the item id for a movie, `{id}:{season}:{episode}` for an episode.',
        'tt0903747:1:1',
      ),
    }),
    query: z.object({
      engine: z
        .string()
        .regex(new RegExp(ENGINE_ID_PATTERN))
        .optional()
        .openapi({
          param: { name: 'engine', in: 'query' },
          description:
            'Engine to rank for. Default: `MULTITAP_SELECTION_DEFAULT_ENGINE`, else the only engine there is.',
          example: 'home',
        }),
      highRes: z
        .enum(HIGH_RES_POLICIES)
        .optional()
        .openapi({
          param: { name: 'highRes', in: 'query' },
          description:
            "Sources above the engine's live limit: `off` marks them unplayable, `prepareOnly`/`on` playable once prepared. Default: configured.",
        }),
      sort: z
        .enum(SOURCE_ORDERS)
        .optional()
        .openapi({ param: { name: 'sort', in: 'query' }, description: 'Default `addon`.' }),
      incremental: z
        .enum(['true', 'false'])
        .optional()
        .openapi({
          param: { name: 'incremental', in: 'query' },
          description:
            'Answer at once and send results as `streams.partial` events. Default `false`.',
        }),
      explain: z
        .enum(['true', 'false'])
        .optional()
        .openapi({
          param: { name: 'explain', in: 'query' },
          description:
            'Attach `explain` to each candidate: the ordered rules that moved its score (summing exactly to `score`), the weights used and the playability reason. Also applies to `streams.partial` events. Default `false`; without it the response is unchanged.',
        }),
      preferredLanguage: z
        .string()
        .regex(PREFERRED_LANGUAGE_QUERY)
        .optional()
        .openapi({
          param: { name: 'preferredLanguage', in: 'query' },
          description:
            "Preferred audio languages for ranking, comma-separated, most preferred first: ISO 639-2 (B or T) or 639-3 codes. Default: the profile's audio languages (with `profileId`), else the instance's `MULTITAP_SELECTION_PREFERRED_LANGUAGE`.",
          example: 'ita,eng',
        }),
      preferBingeGroup: z
        .string()
        .min(1)
        .max(MAX_BINGE_GROUP_LENGTH)
        .optional()
        .openapi({
          param: { name: 'preferBingeGroup', in: 'query' },
          description:
            "Rank candidates with this `bingeGroup` up (`binge.matchBonus`), e.g. the previous episode's session `bingeGroup`.",
          example: 'torrentio|1080p|WEB-DL',
        }),
      profileId: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .openapi({
          param: { name: 'profileId', in: 'query' },
          description:
            'List for a profile: its audio languages are the preferred languages when `preferredLanguage` is absent (before the instance default), and the source it last played for this video is flagged `lastUsed` and ranked up (`lastSource.matchBonus`). An unknown profile is a `400`.',
          example: 'pr_3q2x7wAbCdEfGhIjKlMnOp',
        }),
    }),
  },
  responses: {
    200: json('The candidates and every addon asked', SourceListSchema),
    202: json('Started: results follow as `streams.partial` events', SourceListStartedSchema),
    ...badRequest('The request failed validation, or the engine is unknown'),
    ...authResponses,
  },
});

// ---- Subtitles --------------------------------------------------------------------

const subtitlesRoute = createRoute({
  method: 'get',
  path: '/v1/subtitles/{type}/{videoId}',
  operationId: 'listSubtitles',
  summary: 'Addon subtitles for a video',
  description:
    "Aggregated like streams, in collection order. Each track's `url` is a Multitap path serving the file as WebVTT. " +
    'A client that knows the file can pass `videoHash`, `videoSize` and `filename`, which addons such as ' +
    'OpenSubtitles use to match subtitles that are in sync with it. ' +
    '(`file` is not a usable `type`: `/v1/subtitles/file/…` serves files.)',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      type: typeParam,
      videoId: itemIdParam('videoId', 'Video id, as for `/v1/streams`.', 'tt1375666'),
    }),
    query: z.object({
      videoHash: z
        .string()
        .regex(/^[0-9a-f]{16}$/)
        .optional()
        .openapi({
          param: { name: 'videoHash', in: 'query' },
          description:
            'OpenSubtitles hash of the file (16 lower-case hex digits), sent to the addons as the `videoHash` extra. ' +
            'For a session, `GET /v1/sessions/{id}/subtitles` finds it itself.',
          example: '8e245d9679d31e12',
        }),
      videoSize: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional()
        .openapi({
          param: { name: 'videoSize', in: 'query' },
          description: 'File size in bytes (the `videoSize` extra).',
          example: '1503238553',
        }),
      filename: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .openapi({
          param: { name: 'filename', in: 'query' },
          description: 'File name (the `filename` extra).',
          example: 'Inception.2010.1080p.BluRay.mkv',
        }),
    }),
  },
  responses: {
    200: json('The tracks and every addon asked', SubtitleListSchema),
    ...badRequest('The request failed validation'),
    ...authResponses,
  },
});

const subtitleFileRoute = createRoute({
  method: 'get',
  path: '/v1/subtitles/file/{file}',
  operationId: 'getSubtitleFile',
  summary: 'A subtitle file as WebVTT',
  description:
    "A file listed by `/v1/subtitles/…` (its `url`), fetched from the addon's server and converted from SRT, " +
    'ASS/SSA or WebVTT. File ids expire; list again after a 404. `offsetMs` shifts every cue (signed milliseconds, ' +
    'clamped to 600000 either way): a start before 0 becomes 0 and a cue ending at or before 0 is dropped.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      file: z
        .string()
        .regex(/^[A-Za-z0-9_-]{32}\.vtt$/)
        .openapi({
          param: { name: 'file', in: 'path' },
          description: '`{id}.vtt`, with a track id from the subtitle list.',
          example: '3q2-7wAbCdEfGhIjKlMnOpQrStUvWxYz.vtt',
        }),
    }),
    query: z.object({
      offsetMs: z
        .string()
        .regex(/^-?\d{1,9}$/)
        .optional()
        .openapi({
          param: { name: 'offsetMs', in: 'query' },
          description:
            'Timing offset in milliseconds (signed integer; clamped to 600000 either way). Positive shows cues later.',
          example: '-1500',
        }),
    }),
  },
  responses: {
    200: {
      description: 'The file as WebVTT',
      content: { 'text/vtt': { schema: z.string() } },
    },
    ...badRequest('The request failed validation'),
    403: authResponses[403],
    404: problemContent(
      'No listed subtitle file with this id (or it expired), or the API key is missing, invalid or revoked',
    ),
    502: problemContent(
      "The file could not be fetched from the addon's server, is too large, or is in no supported format",
    ),
  },
});

// ---- Handlers ---------------------------------------------------------------------

/**
 * Checks a catalog request's extras against the catalog's declared props and
 * returns them in the manifest's order (so equal requests encode, and cache,
 * alike).
 */
export function catalogExtras(
  catalog: Pick<ManifestCatalog, 'extra'>,
  query: Record<string, string[]>,
): ExtraValue[] {
  const byName = new Map<string, ExtraProp>(catalog.extra.map((prop) => [prop.name, prop]));
  const unknown = Object.keys(query).filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new ProblemError(
      400,
      `This catalog does not accept: ${unknown.join(', ')}. It accepts: ${
        catalog.extra.map((prop) => prop.name).join(', ') || 'no extras'
      }.`,
    );
  }
  const extras: ExtraValue[] = [];
  for (const prop of catalog.extra) {
    const values = query[prop.name] ?? [];
    if (values.length === 0) {
      if (prop.isRequired) throw new ProblemError(400, `This catalog requires '${prop.name}'.`);
      continue;
    }
    const limit = Math.max(1, prop.optionsLimit);
    if (values.length > limit) {
      throw new ProblemError(
        400,
        `'${prop.name}' takes at most ${String(limit)} value${limit === 1 ? '' : 's'}.`,
      );
    }
    for (const value of values) {
      if (value === '' || value.length > 500) {
        throw new ProblemError(400, `'${prop.name}' must be 1 to 500 characters.`);
      }
      if (prop.options.length > 0 && !prop.options.includes(value)) {
        throw new ProblemError(400, `'${prop.name}' must be one of the catalog's options.`);
      }
      extras.push({ name: prop.name, value });
    }
  }
  return extras;
}

const notOk = (addons: readonly AddonStatus[]) =>
  addons.filter((addon) => addon.status !== 'ok').length;

/** `/v1` browse routes. The caller mounts the client-scope middleware. */
export function registerBrowseRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const logResult = (
    reqId: string,
    route: string,
    counts: { addons: number; items: number; notOk: number },
  ) => {
    deps.logger.info({ reqId, route, ...counts }, 'browse result');
  };

  app.openapi(catalogsRoute, async (c) => {
    const index = await deps.addons.collection.index();
    const catalogs = index.catalogs().map((entry): CatalogRef => ({
      addonId: entry.addonId,
      addonName: entry.addonName,
      type: entry.type,
      id: entry.id,
      name: entry.name ?? null,
      extra: entry.extra.map((prop) => ({
        name: prop.name,
        isRequired: prop.isRequired,
        options: prop.options,
        optionsLimit: prop.optionsLimit,
      })),
    }));
    return c.json(catalogs, 200);
  });

  app.openapi(catalogRoute, async (c) => {
    const { addonId, type, id } = c.req.valid('param');
    const record = await deps.addons.collection.get(addonId);
    const catalog = record?.enabled
      ? record.manifest.catalogs.find((entry) => entry.type === type && entry.id === id)
      : undefined;
    if (record === undefined || catalog === undefined) {
      throw new ProblemError(404, 'No enabled addon with this id offers this catalog.');
    }
    const extra = catalogExtras(catalog, c.req.queries());
    const result = await deps.addons.aggregate('catalog', type, id, extra, {
      addonIds: [record.id],
      onOutcome: (outcome) => {
        const addonOutcome =
          outcome.status === 'ok' ? 'success' : outcome.status === 'timeout' ? 'timeout' : 'error';
        deps.metrics.recordAddonOutcome(outcome.addonId, 'catalog', addonOutcome);
      },
    });
    const outcome = result.addons[0];
    if (outcome === undefined) {
      // Disabled or changed while the request ran.
      throw new ProblemError(404, 'No enabled addon with this id offers this catalog.');
    }
    const status = addonStatus(outcome);
    logResult(c.get('requestId'), catalogRoute.path, {
      addons: 1,
      items: outcome.items.length,
      notOk: notOk([status]),
    });
    const { safety } = await rankingStore(deps).effective();
    return c.json(
      { metas: outcome.items.map((item) => metaPreviewView(item, safety)), addon: status },
      200,
    );
  });

  app.openapi(searchRoute, async (c) => {
    const query = c.req.valid('query');
    const skip = query.skip === undefined ? 0 : Number(query.skip);
    const wanted = [
      ...(query.type === undefined ? [] : [query.type]),
      ...(query.types?.split(',') ?? []),
    ]
      .map((type) => type.trim())
      .filter((type) => type !== '');
    if (wanted.length > SEARCH_MAX_TYPES) {
      throw new ProblemError(400, `At most ${String(SEARCH_MAX_TYPES)} types can be given.`);
    }
    const index = await deps.addons.collection.index();
    const { safety } = await rankingStore(deps).effective();
    const targets = searchTargets(
      index.catalogs(),
      query.q,
      skip,
      wanted.length === 0 ? undefined : new Set(wanted),
    );
    const settled = await Promise.all(
      targets.map(async ({ entry, extra }): Promise<SearchSource | undefined> => {
        const result = await deps.addons.aggregate('catalog', entry.type, entry.id, extra, {
          addonIds: [entry.addonId],
          onOutcome: (outcome) => {
            const kind =
              outcome.status === 'ok'
                ? 'success'
                : outcome.status === 'timeout'
                  ? 'timeout'
                  : 'error';
            deps.metrics.recordAddonOutcome(outcome.addonId, 'catalog', kind);
          },
        });
        const outcome = result.addons[0];
        // Disabled or changed while the request ran.
        if (outcome === undefined) return undefined;
        return {
          addonId: entry.addonId,
          addonName: entry.addonName,
          catalogId: entry.id,
          catalogName: entry.name ?? null,
          type: entry.type,
          skip,
          metas: outcome.items.map((item) => metaPreviewView(item, safety)),
          addon: addonStatus(outcome),
        };
      }),
    );
    const sources = settled.filter((source): source is SearchSource => source !== undefined);
    logResult(c.get('requestId'), searchRoute.path, {
      addons: sources.length,
      items: sources.reduce((sum, source) => sum + source.metas.length, 0),
      notOk: notOk(sources.map((source) => source.addon)),
    });
    return c.json({ query: query.q, skip, sources }, 200);
  });

  app.openapi(metaRoute, async (c) => {
    const { type, id } = c.req.valid('param');
    const result = await deps.addons.aggregate('meta', type, id, [], {
      onOutcome: (outcome) => {
        const addonOutcome =
          outcome.status === 'ok' ? 'success' : outcome.status === 'timeout' ? 'timeout' : 'error';
        deps.metrics.recordAddonOutcome(outcome.addonId, 'meta', addonOutcome);
      },
    });
    const addons = result.addons.map((outcome) => addonStatus(outcome));
    logResult(c.get('requestId'), metaRoute.path, {
      addons: addons.length,
      items: result.items.length,
      notOk: notOk(addons),
    });
    // Stremio's rule: the first addon in collection order that has one.
    const first = result.addons.find((outcome) => outcome.status === 'ok' && outcome.items[0]);
    const meta = first?.items[0];
    if (first === undefined || meta === undefined) {
      throw new ProblemError(
        404,
        addons.length === 0
          ? 'No enabled addon serves meta for this type and id.'
          : 'No addon returned a meta for this item.',
      );
    }
    const { safety } = await rankingStore(deps).effective();
    return c.json({ meta: metaDetailView(meta, safety), addonId: first.addonId, addons }, 200);
  });

  app.openapi(streamsRoute, async (c) => {
    const { type, videoId } = c.req.valid('param');
    const query = c.req.valid('query');
    let engineId = query.engine;
    try {
      engineId ??= await defaultEngineId(deps.db, deps.config.selection.defaultEngine);
    } catch (err) {
      if (err instanceof NoDefaultEngineError) throw new ProblemError(400, err.message);
      throw err;
    }
    const engine = await getEngine(deps.db, engineId);
    if (engine === undefined) throw new ProblemError(400, `Unknown engine '${engineId}'.`);
    const highRes = query.highRes ?? deps.config.selection.defaultHighRes;
    const sort = query.sort ?? 'addon';
    const sourceDeps = { addons: deps.addons, streams: deps.streams, meta: itemMetaLookup(deps) };
    const profile = await profileSelection(deps, query.profileId, videoId);
    const request = {
      type,
      videoId,
      engine,
      highRes,
      rank: {
        settings: await rankingStore(deps).effective(),
        // Request > profile > instance default.
        preferredLanguages: resolvePreferredLanguages({
          request: query.preferredLanguage?.split(','),
          profile: profile?.preferredLanguages,
          instance: deps.config.selection.preferredLanguage,
        }),
        preferBingeGroup: query.preferBingeGroup,
        lastSource: profile?.lastSourceIdentity,
        explain: query.explain === 'true',
      },
    };
    const bus = deps.events;
    if (query.incremental === 'true' && bus !== undefined) {
      const requestId = (deps.ids ?? randomIds).request();
      const reqId = c.get('requestId');
      const started = await startSourceList(sourceDeps, request, (partial) => {
        bus.publish({
          type: 'streams.partial',
          data: {
            requestId,
            addon: partial.addon,
            candidates: sort === 'rank' ? sortByRank(partial.candidates) : partial.candidates,
            remaining: partial.remaining,
          },
        });
      });
      started.done.then(
        ({ candidates, addons }) => {
          logResult(reqId, streamsRoute.path, {
            addons: addons.length,
            items: candidates.length,
            notOk: notOk(addons),
          });
        },
        (err: unknown) => {
          deps.logger.error({ reqId, err }, 'incremental source list failed');
        },
      );
      return c.json({ requestId, engine: engine.id, highRes, addons: started.asked }, 202);
    }
    const { candidates, addons } = await (await startSourceList(sourceDeps, request)).done;
    logResult(c.get('requestId'), streamsRoute.path, {
      addons: addons.length,
      items: candidates.length,
      notOk: notOk(addons),
    });
    return c.json(
      {
        engine: engine.id,
        highRes,
        sort,
        candidates: sort === 'rank' ? sortByRank(candidates) : candidates,
        addons,
      },
      200,
    );
  });

  // Registered before the list route: `/v1/subtitles/file/…` would match both.
  app.openapi(subtitleFileRoute, async (c) => {
    const fileId = c.req.valid('param').file.slice(0, -'.vtt'.length);
    let vtt: string;
    try {
      const { offsetMs } = c.req.valid('query');
      vtt = await deps.subtitles.file(fileId, offsetMs === undefined ? 0 : Number(offsetMs));
    } catch (err) {
      if (err instanceof SubtitleFileError) {
        throw new ProblemError(err.code === 'not-found' ? 404 : 502, err.message);
      }
      throw err;
    }
    return c.body(vtt, 200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'private, max-age=600',
    });
  });

  app.openapi(subtitlesRoute, async (c) => {
    const { type, videoId } = c.req.valid('param');
    const hints = c.req.valid('query');
    const list = await deps.subtitles.list(type, videoId, {
      videoHash: hints.videoHash,
      videoSize: hints.videoSize === undefined ? undefined : Number(hints.videoSize),
      filename: hints.filename,
    });
    logResult(c.get('requestId'), subtitlesRoute.path, {
      addons: list.addons.length,
      items: list.subtitles.length,
      notOk: notOk(list.addons),
    });
    return c.json(list, 200);
  });
}
