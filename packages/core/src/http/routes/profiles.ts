/**
 * `/v1/profiles`: profiles and their Stremio-format library (okf:architecture/library-and-profiles,
 * okf:architecture/library-and-profiles, okf:architecture/core-v1-api). Client scope; the rules are in `src/library/`.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CreateProfileSchema,
  ItemPlayerStateSchema,
  LibraryItemListSchema,
  LibraryItemSchema,
  MarkWatchedSchema,
  MAX_CLIENT_SETTINGS_BYTES,
  NextVideoSchema,
  ProfileListSchema,
  ProfileSchema,
  ProgressReportSchema,
  UpdateItemPlayerStateSchema,
  UpdateProfileSchema,
  type LibraryItem,
} from '@multitap/api';
import type { WriteResult } from '../../library/service.ts';
import { authResponses, BEARER_SECURITY, validationResponse } from '../openapi.ts';
import { problemContent, ProblemError } from '../problem.ts';
import { libraryService as libraryOf } from '../selection-deps.ts';
import type { AppDeps, AppEnv } from '../types.ts';

const tags = ['profiles'];
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const profileId = z
  .string()
  .min(1)
  .max(100)
  .openapi({ param: { name: 'id', in: 'path' }, example: 'pr_3q2x7wAbCdEfGhIjKlMnOp' });
const ProfileParams = z.object({ id: profileId });
const NextParams = z.object({
  id: profileId,
  type: z
    .string()
    .min(1)
    .max(100)
    .openapi({ param: { name: 'type', in: 'path' }, example: 'series' }),
  itemId: z
    .string()
    .min(1)
    .max(500)
    .openapi({ param: { name: 'itemId', in: 'path' }, example: 'tt0903747' }),
});

const VideoParams = z.object({
  ...NextParams.shape,
  videoId: z
    .string()
    .min(1)
    .max(500)
    .openapi({ param: { name: 'videoId', in: 'path' }, example: 'tt0903747:1:1' }),
});
const SeasonParams = z.object({
  ...NextParams.shape,
  season: z
    .string()
    .regex(/^\d{1,5}$/)
    .openapi({
      param: { name: 'season', in: 'path' },
      description: 'The season number (0 = specials).',
      example: '1',
    }),
});
const LibraryQuery = z.object({
  type: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .openapi({
      param: { name: 'type', in: 'query' },
      description: 'Only items of this type.',
      example: 'series',
    }),
  removed: z
    .enum(['true', 'false'])
    .optional()
    .openapi({
      param: { name: 'removed', in: 'query' },
      description:
        '`false` = only items in the library (what a "My list" shows); `true` = only removed ones, ' +
        'including those kept by playback (`temp`). Absent = every item.',
      example: 'false',
    }),
});

const noProfile = 'No profile with this id, or the API key is missing, invalid or revoked';

/**
 * OpenAPI links (okf:architecture/core-api-testing) for the profile lifecycle: create → progress → library →
 * continue (→ next, delete). Schemathesis's stateful phase follows them.
 */
const libraryLinks = (id: string) => ({
  GetLibrary: {
    operationId: 'getLibrary',
    parameters: { id },
    description: "The profile's library.",
  },
  GetContinueWatching: {
    operationId: 'getContinueWatching',
    parameters: { id },
    description: "The profile's continue-watching list.",
  },
});
const profileLinks = (id: string) => ({
  ReportProgress: {
    operationId: 'reportProgress',
    parameters: { id },
    description: 'Report progress into the profile.',
  },
  ...libraryLinks(id),
  GetProfile: { operationId: 'getProfile', parameters: { id }, description: 'Read the profile.' },
  UpdateProfile: {
    operationId: 'updateProfile',
    parameters: { id },
    description: 'Rename the profile or change its settings.',
  },
  DeleteProfile: {
    operationId: 'deleteProfile',
    parameters: { id },
    description: 'Delete the profile and its library.',
  },
});
const NO_PROFILE = 'No profile with this id.';

const createRouteDef = createRoute({
  method: 'post',
  path: '/v1/profiles',
  operationId: 'createProfile',
  summary: 'Create a profile',
  description: 'A profile owns a library. It has no credentials; clients map their users to it.',
  tags,
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateProfileSchema } } },
  },
  responses: {
    201: { ...json('The profile', ProfileSchema), links: profileLinks('$response.body#/id') },
    ...validationResponse,
    ...authResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/v1/profiles',
  operationId: 'listProfiles',
  summary: 'List profiles',
  tags,
  security: BEARER_SECURITY,
  responses: {
    200: json('Every profile, oldest first', ProfileListSchema),
    ...authResponses,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/profiles/{id}',
  operationId: 'getProfile',
  summary: 'Get a profile',
  tags,
  security: BEARER_SECURITY,
  request: { params: ProfileParams },
  responses: {
    200: json('The profile', ProfileSchema),
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/v1/profiles/{id}',
  operationId: 'updateProfile',
  summary: 'Rename a profile or change its settings',
  description:
    'Both parts optional. `name` follows the create rules (stored as given). `settings` is a ' +
    "partial `ProfileSettings` (stremio-core's field names): each typed field given replaces " +
    'its value, unknown fields are rejected; `client` keys merge into the stored bag and a key ' +
    'set to null is removed. Only what a client set is stored; the rest follows the defaults. ' +
    'A merged `client` bag over its size limit is a `400`.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: ProfileParams,
    body: { required: true, content: { 'application/json': { schema: UpdateProfileSchema } } },
  },
  responses: {
    200: {
      ...json('The profile', ProfileSchema),
      links: { GetProfile: profileLinks('$request.path.id').GetProfile },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/v1/profiles/{id}',
  operationId: 'deleteProfile',
  summary: 'Delete a profile and its library',
  tags,
  security: BEARER_SECURITY,
  request: { params: ProfileParams },
  responses: {
    204: { description: 'Deleted' },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const progressRoute = createRoute({
  method: 'post',
  path: '/v1/profiles/{id}/progress',
  operationId: 'reportProgress',
  summary: 'Report playback progress',
  description:
    'Multitap applies stremio-core\'s rules: time watched, "watched" past 70% of the duration, ' +
    'moving on to the next episode when stopped past 90%, and the watched-episodes bitfield. ' +
    'The item is written at most every 90 s while playing, and at once on `pause`, `stop`, ' +
    '`ended`, or a report for another item or video. Reads see the written item.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: ProfileParams,
    body: { required: true, content: { 'application/json': { schema: ProgressReportSchema } } },
  },
  responses: {
    200: {
      ...json(
        'The library item after the report (possibly ahead of the written one)',
        LibraryItemSchema,
      ),
      links: {
        ...libraryLinks('$request.path.id'),
        GetNextVideo: {
          operationId: 'getNextVideo',
          parameters: {
            id: '$request.path.id',
            type: '$response.body#/type',
            itemId: '$response.body#/_id',
          },
          description: 'The video to play next for the reported item.',
        },
        GetItemPlayerState: {
          operationId: 'getItemPlayerState',
          parameters: {
            id: '$request.path.id',
            type: '$response.body#/type',
            itemId: '$response.body#/_id',
          },
          description: "The profile's player state for the reported item.",
        },
      },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const libraryRoute = createRoute({
  method: 'get',
  path: '/v1/profiles/{id}/library',
  operationId: 'getLibrary',
  summary: "A profile's library items",
  description:
    'By default every item, including those only added by playback (`removed` and `temp`), most ' +
    'recently changed first. `removed=false` gives the library proper.',
  tags,
  security: BEARER_SECURITY,
  request: { params: ProfileParams, query: LibraryQuery },
  responses: {
    200: {
      ...json('The library items', LibraryItemListSchema),
      links: { GetContinueWatching: libraryLinks('$request.path.id').GetContinueWatching },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const continueRoute = createRoute({
  method: 'get',
  path: '/v1/profiles/{id}/continue',
  operationId: 'getContinueWatching',
  summary: 'Continue watching',
  description:
    "stremio-core's continue-watching list: items with a position to resume (not live, not " +
    'removed unless temporary), most recently changed first, at most 100.',
  tags,
  security: BEARER_SECURITY,
  request: { params: ProfileParams },
  responses: {
    200: json('The items to continue', LibraryItemListSchema),
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const nextRoute = createRoute({
  method: 'get',
  path: '/v1/profiles/{id}/next/{type}/{itemId}',
  operationId: 'getNextVideo',
  summary: 'The video to play next for an item',
  description:
    "Uses the addons' meta for episode order: the item's video while it has a position to " +
    'resume (including the episode it moved on to), otherwise the episode after the last one ' +
    "(not crossing into specials, released only), or the meta's default or first video for an " +
    'item not watched yet. Null for movies, live items and after the last episode.',
  tags,
  security: BEARER_SECURITY,
  request: { params: NextParams },
  responses: {
    200: json('The next video', NextVideoSchema),
    ...validationResponse,
    ...authResponses,
    404: problemContent(
      'No profile with this id, no addon returned a meta for the item, or the API key is missing, invalid or revoked',
    ),
  },
});

/** Links after a library write: reading the library back. */
const itemWriteLinks = {
  GetLibrary: libraryLinks('$request.path.id').GetLibrary,
  GetContinueWatching: libraryLinks('$request.path.id').GetContinueWatching,
};
const itemParams = {
  id: '$request.path.id',
  type: '$request.path.type',
  itemId: '$request.path.itemId',
};
const itemWriteResponses = (description: string, notFound: string) => ({
  200: { ...json(description, LibraryItemSchema), links: itemWriteLinks },
  ...validationResponse,
  ...authResponses,
  404: problemContent(notFound),
});

const addRoute = createRoute({
  method: 'put',
  path: '/v1/profiles/{id}/library/{type}/{itemId}',
  operationId: 'addToLibrary',
  summary: 'Add an item to the library',
  description:
    "stremio-core's `AddToLibrary`: the item is built from the addons' meta (name, poster, " +
    'hints; an existing item is refreshed from it) and put in the library (`removed` and ' +
    '`temp` false). Progress already kept is untouched. Idempotent. 404 when no addon returns ' +
    'a meta and the item is not stored.',
  tags,
  security: BEARER_SECURITY,
  request: { params: NextParams },
  responses: {
    200: {
      ...json('The library item', LibraryItemSchema),
      links: {
        ...itemWriteLinks,
        RemoveFromLibrary: { operationId: 'removeFromLibrary', parameters: itemParams },
        RewindLibraryItem: { operationId: 'rewindLibraryItem', parameters: itemParams },
        MarkLibraryItemWatched: { operationId: 'markLibraryItemWatched', parameters: itemParams },
      },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent('No such profile, or no addon returned a meta for the item'),
  },
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/v1/profiles/{id}/library/{type}/{itemId}',
  operationId: 'removeFromLibrary',
  summary: 'Remove an item from the library',
  description:
    "stremio-core's `RemoveFromLibrary`: `removed` true and `temp` false, so the item leaves " +
    'the library and continue watching. Its progress and watched state are kept (adding it ' +
    'again brings them back). The item stays in `GET …/library` as removed.',
  tags,
  security: BEARER_SECURITY,
  request: { params: NextParams },
  responses: itemWriteResponses('The removed item', 'No such profile or item'),
});

const rewindRoute = createRoute({
  method: 'post',
  path: '/v1/profiles/{id}/library/{type}/{itemId}/rewind',
  operationId: 'rewindLibraryItem',
  summary: 'Rewind an item',
  description:
    "stremio-core's `RewindLibraryItem`: clears the position to resume (`timeOffset` 0), " +
    'which drops the item from continue watching. Watched state is kept.',
  tags,
  security: BEARER_SECURITY,
  request: { params: NextParams },
  responses: itemWriteResponses('The rewound item', 'No such profile or item'),
});

const markWatchedRoute = createRoute({
  method: 'post',
  path: '/v1/profiles/{id}/library/{type}/{itemId}/watched',
  operationId: 'markLibraryItemWatched',
  summary: 'Mark an item watched or unwatched',
  description:
    "stremio-core's `LibraryItemMarkAsWatched` / `MetaItemMarkAsWatched`: `watched: true` adds " +
    'one to the times watched, sets the last watched time and clears the resume position; ' +
    '`false` resets the times watched to 0. Marking watched an item that is not stored ' +
    'creates it from the meta as `removed` and `temp` (not in the library); unmarking one ' +
    'that is not stored is a 404. Per-episode state (`state.watched`) is not changed; use the ' +
    'video and season routes.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: NextParams,
    body: { required: true, content: { 'application/json': { schema: MarkWatchedSchema } } },
  },
  responses: itemWriteResponses(
    'The item',
    'No such profile or item, or (marking watched an unstored item) no addon returned a meta',
  ),
});

const markVideoRoute = createRoute({
  method: 'post',
  path: '/v1/profiles/{id}/library/{type}/{itemId}/videos/{videoId}/watched',
  operationId: 'markVideoWatched',
  summary: 'Mark one episode (video) watched or unwatched',
  description:
    "stremio-core's `MarkVideoAsWatched`: sets the video in the item's watched bitfield and, " +
    "when watched, moves the last watched time up to the video's release. If it is the item's " +
    'current video, the item moves on to the next released video (position 1, so it stays in ' +
    'continue watching), or clears the position when there is none. Needs the meta from the ' +
    "addons for the video list. Marking watched an unstored item creates it as stremio-core's " +
    '`MetaItemMarkAsWatched` does (`removed` and `temp`). 404 for an unknown video.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: VideoParams,
    body: { required: true, content: { 'application/json': { schema: MarkWatchedSchema } } },
  },
  responses: itemWriteResponses(
    'The item',
    'No such profile, item (when unmarking) or video, or no addon returned a meta',
  ),
});

const markSeasonRoute = createRoute({
  method: 'post',
  path: '/v1/profiles/{id}/library/{type}/{itemId}/seasons/{season}/watched',
  operationId: 'markSeasonWatched',
  summary: 'Mark a whole season watched or unwatched',
  description:
    "stremio-core's `MarkSeasonAsWatched`: sets every video of the season (videos with a " +
    'season and episode number). When marking watched and the current video is in that season ' +
    'and now watched, the resume pointer moves to the first released unwatched episode after it ' +
    '(position 1), or the position is cleared when there is none; unmarking leaves the pointer ' +
    'alone. 404 when the season has no videos.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: SeasonParams,
    body: { required: true, content: { 'application/json': { schema: MarkWatchedSchema } } },
  },
  responses: itemWriteResponses(
    'The item',
    'No such profile, item (when unmarking) or season, or no addon returned a meta',
  ),
});

/** Links between the two player-state routes (okf:architecture/core-api-testing). */
const playerStateLinks = {
  GetItemPlayerState: {
    operationId: 'getItemPlayerState',
    parameters: itemParams,
    description: 'Read the player state back.',
  },
  SetItemPlayerState: {
    operationId: 'setItemPlayerState',
    parameters: itemParams,
    description: 'Change the player state.',
  },
};

const getPlayerStateRoute = createRoute({
  method: 'get',
  path: '/v1/profiles/{id}/items/{type}/{itemId}/state',
  operationId: 'getItemPlayerState',
  summary: "A profile's player state for an item",
  description:
    "stremio-core's `StreamItemState`: the audio language, subtitle, subtitle offset and playback " +
    'speed the profile chose for the item, kept per profile and item (like its last source). ' +
    'Nothing stored is the empty state (`updatedAt` null). A session created with the ' +
    "profile's `profileId` starts with the stored `audioLanguage` when the request names none, " +
    'and with the stored `subtitleOffsetMs` on the chosen addon subtitle file.',
  tags,
  security: BEARER_SECURITY,
  request: { params: NextParams },
  responses: {
    200: {
      ...json('The player state', ItemPlayerStateSchema),
      links: { SetItemPlayerState: playerStateLinks.SetItemPlayerState },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

const setPlayerStateRoute = createRoute({
  method: 'put',
  path: '/v1/profiles/{id}/items/{type}/{itemId}/state',
  operationId: 'setItemPlayerState',
  summary: "Change a profile's player state for an item",
  description:
    'Each field given replaces the stored value (null clears it); fields left out are kept, so ' +
    'a player can write one choice at a time. Languages are the durable part: track indexes ' +
    'change with the source, so a client matches the stored subtitle by language (and by ' +
    'addon file id while that addon still offers it). The item need not be in the library. ' +
    'Idempotent.',
  tags,
  security: BEARER_SECURITY,
  request: {
    params: NextParams,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateItemPlayerStateSchema } },
    },
  },
  responses: {
    200: {
      ...json('The stored player state', ItemPlayerStateSchema),
      links: {
        GetItemPlayerState: playerStateLinks.GetItemPlayerState,
        GetLibrary: libraryLinks('$request.path.id').GetLibrary,
      },
    },
    ...validationResponse,
    ...authResponses,
    404: problemContent(noProfile),
  },
});

/** `/v1/profiles`. Client scope (the app's `/v1/*` middleware). */
export function registerProfileRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(createRouteDef, async (c) => {
    const profile = await libraryOf(deps).createProfile(c.req.valid('json').name);
    deps.logger.info({ profileId: profile.id, by: c.get('apiKey').id }, 'profile created');
    return c.json(profile, 201);
  });

  app.openapi(listRoute, async (c) =>
    c.json({ profiles: await libraryOf(deps).listProfiles() }, 200),
  );

  app.openapi(getRoute, async (c) => {
    const profile = await libraryOf(deps).getProfile(c.req.valid('param').id);
    if (profile === undefined) throw new ProblemError(404, NO_PROFILE);
    return c.json(profile, 200);
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const update = c.req.valid('json');
    const result = await libraryOf(deps).updateProfile(id, update);
    if (result.kind === 'no-profile') throw new ProblemError(404, NO_PROFILE);
    if (result.kind === 'client-too-large') {
      throw new ProblemError(
        400,
        `The client settings would be over ${String(MAX_CLIENT_SETTINGS_BYTES)} bytes of JSON.`,
      );
    }
    deps.logger.info(
      {
        profileId: id,
        by: c.get('apiKey').id,
        renamed: update.name !== undefined,
        settings: Object.keys(update.settings ?? {}),
      },
      'profile updated',
    );
    return c.json(result.profile, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    if (!(await libraryOf(deps).deleteProfile(id))) throw new ProblemError(404, NO_PROFILE);
    deps.logger.info({ profileId: id, by: c.get('apiKey').id }, 'profile deleted');
    return c.body(null, 204);
  });

  app.openapi(progressRoute, async (c) => {
    const item = await libraryOf(deps).report(c.req.valid('param').id, c.req.valid('json'));
    if (item === undefined) throw new ProblemError(404, NO_PROFILE);
    return c.json(item, 200);
  });

  app.openapi(libraryRoute, async (c) => {
    const { type, removed } = c.req.valid('query');
    const items = await libraryOf(deps).library(c.req.valid('param').id, {
      type,
      removed: removed === undefined ? undefined : removed === 'true',
    });
    if (items === undefined) throw new ProblemError(404, NO_PROFILE);
    return c.json({ items }, 200);
  });

  const written = (result: WriteResult): LibraryItem => {
    switch (result.kind) {
      case 'ok':
        return result.item;
      case 'no-profile':
        throw new ProblemError(404, NO_PROFILE);
      case 'no-item':
        throw new ProblemError(404, 'No such item in this profile.');
      case 'no-meta':
        throw new ProblemError(404, 'No addon returned a meta for this item.');
      case 'no-video':
        throw new ProblemError(404, 'The item has no such video or season.');
    }
  };

  app.openapi(addRoute, async (c) => {
    const { id, type, itemId } = c.req.valid('param');
    return c.json(written(await libraryOf(deps).addToLibrary(id, type, itemId)), 200);
  });

  app.openapi(removeRoute, async (c) => {
    const { id, itemId } = c.req.valid('param');
    return c.json(written(await libraryOf(deps).removeFromLibrary(id, itemId)), 200);
  });

  app.openapi(rewindRoute, async (c) => {
    const { id, itemId } = c.req.valid('param');
    return c.json(written(await libraryOf(deps).rewind(id, itemId)), 200);
  });

  app.openapi(markWatchedRoute, async (c) => {
    const { id, type, itemId } = c.req.valid('param');
    const { watched } = c.req.valid('json');
    return c.json(written(await libraryOf(deps).markWatched(id, type, itemId, watched)), 200);
  });

  app.openapi(markVideoRoute, async (c) => {
    const { id, type, itemId, videoId } = c.req.valid('param');
    const { watched } = c.req.valid('json');
    const result = await libraryOf(deps).markVideoWatched(id, type, itemId, videoId, watched);
    return c.json(written(result), 200);
  });

  app.openapi(markSeasonRoute, async (c) => {
    const { id, type, itemId, season } = c.req.valid('param');
    const { watched } = c.req.valid('json');
    const result = await libraryOf(deps).markSeasonWatched(
      id,
      type,
      itemId,
      Number(season),
      watched,
    );
    return c.json(written(result), 200);
  });

  app.openapi(continueRoute, async (c) => {
    const items = await libraryOf(deps).continueWatching(c.req.valid('param').id);
    if (items === undefined) throw new ProblemError(404, NO_PROFILE);
    return c.json({ items }, 200);
  });

  app.openapi(getPlayerStateRoute, async (c) => {
    const { id, itemId } = c.req.valid('param');
    const state = await libraryOf(deps).playerState(id, itemId);
    if (state === undefined) throw new ProblemError(404, NO_PROFILE);
    return c.json(state, 200);
  });

  app.openapi(setPlayerStateRoute, async (c) => {
    const { id, itemId } = c.req.valid('param');
    const update = c.req.valid('json');
    const state = await libraryOf(deps).setPlayerState(id, itemId, update);
    if (state === undefined) throw new ProblemError(404, NO_PROFILE);
    deps.logger.debug(
      { profileId: id, by: c.get('apiKey').id, fields: Object.keys(update) },
      'item player state set',
    );
    return c.json(state, 200);
  });

  app.openapi(nextRoute, async (c) => {
    const { id, type, itemId } = c.req.valid('param');
    const result = await libraryOf(deps).next(id, type, itemId);
    if (result.kind === 'no-profile') throw new ProblemError(404, NO_PROFILE);
    if (result.kind === 'no-meta') {
      throw new ProblemError(404, 'No addon returned a meta for this item.');
    }
    const { videoId, video, libraryItem } = result;
    return c.json({ videoId, video, libraryItem }, 200);
  });
}
