/**
 * A fake Stremio addon: a small HTTP server that answers the addon protocol
 * from the captured fixtures in packages/addon-protocol/test/fixtures/real/.
 *
 * - `GET {prefix}/manifest.json` serves the fixture's manifest.
 * - `GET {prefix}/{resource}/{type}/{id}[/{extra}].json` serves
 *   `{resource}-{type}-{id}.json` (with `:` in the id written as `_`), or a
 *   file named in {@link FIXTURE_ALIASES} / `options.routes`.
 * - `subtitleFiles` adds synthetic subtitle files, served raw at
 *   `{prefix}/subs/{name}`; a `subtitles/…` request with no route or fixture
 *   lists them all (no subtitles addon is in the captured set).
 * - Latency, failure modes and routes can be changed while it runs.
 *
 * The prefix stands in for the secret part of a configured addon's URL (for
 * example a debrid key), so tests can check it never leaks.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const FIXTURES_DIR = join(
  import.meta.dirname,
  '../../../../packages/addon-protocol/test/fixtures/real',
);

export type FakeFixture = 'cinemeta' | 'youtube' | 'torrentio-public' | 'torrentio-rd' | 'easynews';

/**
 * Resource paths (as requested, without `.json`) whose fixture file name
 * doesn't follow the default rule, per fixture directory.
 */
export const FIXTURE_ALIASES: Partial<Record<FakeFixture, Record<string, string>>> = {
  cinemeta: {
    'catalog/movie/top/search=dune': 'catalog-movie-top-search',
    'catalog/movie/top/genre=Horror': 'catalog-movie-top-genre',
    'catalog/series/top/skip=100': 'catalog-series-top-skip100',
  },
  youtube: {
    'meta/channel/yt_id:UCq-Fj5jknLsUf-MWSy4_brA': 'meta-channel-first',
  },
};

/**
 * - `ok`: serve fixtures.
 * - `malformed`: list responses get invalid items mixed in (two per list),
 *   and a `meta` becomes invalid as a whole: the validation path.
 * - `invalid-json`: every resource answers 200 with a body that isn't JSON.
 * - `error`: every resource answers HTTP 500.
 * - `not-found`: every resource answers HTTP 404.
 *
 * Modes apply to resources only; the manifest follows `manifestMode`.
 */
export type FakeMode = 'ok' | 'malformed' | 'invalid-json' | 'error' | 'not-found';

/** A synthetic subtitle file. */
export interface FakeSubtitleFile {
  lang: string;
  label?: string;
  body: string | Uint8Array;
  /** Default `application/x-subrip`. */
  contentType?: string;
}

/** Manifest fields that turn any fixture into a subtitles-only addon (pass as `manifest`). */
export const SUBTITLES_MANIFEST = {
  id: 'dev.multitap.fake-subtitles',
  name: 'Fake Subtitles',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

/** One small file per format Multitap converts: SRT, ASS and WebVTT. */
export const SAMPLE_SUBTITLE_FILES: Record<string, FakeSubtitleFile> = {
  'eng.srt': {
    lang: 'eng',
    label: 'English',
    body: '1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> there\r\n\r\n',
  },
  'ita.ass': {
    lang: 'ita',
    contentType: 'text/x-ssa',
    body: [
      '[Script Info]',
      'ScriptType: v4.00+',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:03.00,0:00:04.50,Default,,0,0,0,,{\\an8}Top, line\\Nsecond',
    ].join('\n'),
  },
  'fre.vtt': {
    lang: 'fre',
    contentType: 'text/vtt',
    body: 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nBonjour\n',
  },
};

export interface FakeAddonOptions {
  fixture: FakeFixture;
  /** Path before `/manifest.json`, e.g. `/SECRET-KEY`. Default `''`. */
  prefix?: string;
  /** Fields merged over the fixture manifest (e.g. a different `name` or `version`). */
  manifest?: Record<string, unknown>;
  /** Extra or overriding responses by resource path without `.json`. */
  routes?: Record<string, unknown>;
  /** Delay before answering, per request. */
  latencyMs?: number | ((path: string) => number);
  mode?: FakeMode;
  /** `error` makes the manifest answer HTTP 500. */
  manifestMode?: 'ok' | 'error';
  /** Subtitle files by name, served at `{prefix}/subs/{name}`. */
  subtitleFiles?: Record<string, FakeSubtitleFile>;
  /** Answer unknown resource paths with an empty list instead of 404. Default false. */
  emptyWhenUnknown?: boolean;
}

export interface FakeAddon {
  /** The manifest URL, including the secret prefix. */
  readonly manifestUrl: string;
  readonly origin: string;
  /** Every request path received (decoded, prefix stripped), in order. */
  readonly requests: string[];
  /** Requests for resources only (not the manifest). */
  resourceRequests(): string[];
  set(options: Partial<Omit<FakeAddonOptions, 'fixture' | 'prefix'>>): void;
  close(): Promise<void>;
}

function readFixture(fixture: FakeFixture, name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, fixture, `${name}.json`), 'utf8')) as unknown;
}

function fixtureExists(fixture: FakeFixture, name: string): unknown {
  try {
    return readFixture(fixture, name);
  } catch {
    return undefined;
  }
}

const LIST_KEYS = ['metas', 'streams', 'subtitles', 'metasDetailed', 'addons'] as const;

function malform(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const record = { ...(body as Record<string, unknown>) };
  for (const key of LIST_KEYS) {
    const list: unknown = record[key];
    if (Array.isArray(list)) {
      // A null item and one with the wrong field types: both fail validation.
      record[key] = [null, ...(list as unknown[]), { id: 42, name: false, url: 'not a url' }];
    }
  }
  if ('meta' in record) record.meta = { id: 42 };
  return record;
}

function emptyFor(resource: string): unknown {
  switch (resource) {
    case 'catalog':
      return { metas: [] };
    case 'stream':
      return { streams: [] };
    case 'subtitles':
      return { subtitles: [] };
    default:
      return undefined;
  }
}

/** Starts a fake addon on a free localhost port. */
export async function startFakeAddon(options: FakeAddonOptions): Promise<FakeAddon> {
  const state: FakeAddonOptions = { ...options };
  const prefix = options.prefix ?? '';
  const requests: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let origin = '';
  const subtitleUrl = (name: string) => `${origin}${prefix}/subs/${encodeURIComponent(name)}`;

  const respond = (res: ServerResponse, status: number, body: unknown, raw = false) => {
    const text = raw ? String(body) : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  };

  const answer = (path: string, res: ServerResponse) => {
    if (path === '/manifest.json') {
      if (state.manifestMode === 'error') {
        respond(res, 500, { err: 'boom' });
        return;
      }
      const manifest = readFixture(state.fixture, 'manifest') as Record<string, unknown>;
      respond(res, 200, { ...manifest, ...state.manifest });
      return;
    }
    if (path.startsWith('/subs/')) {
      const file = state.subtitleFiles?.[path.slice('/subs/'.length)];
      if (file === undefined) {
        respond(res, 404, { err: 'not found' });
        return;
      }
      res.writeHead(200, { 'content-type': file.contentType ?? 'application/x-subrip' });
      res.end(file.body);
      return;
    }
    const match = /^\/([^/]+)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
    if (match === null) {
      respond(res, 404, { err: 'not found' });
      return;
    }
    const [, resource = '', type = '', id = '', extra] = match;
    switch (state.mode ?? 'ok') {
      case 'error':
        respond(res, 500, { err: 'boom' });
        return;
      case 'not-found':
        respond(res, 404, { err: 'not found' });
        return;
      case 'invalid-json':
        respond(res, 200, '<html>bad gateway</html>', true);
        return;
      default:
        break;
    }
    const key = `${resource}/${type}/${id}${extra === undefined ? '' : `/${extra}`}`;
    let body: unknown = state.routes?.[key];
    if (body === undefined) {
      const alias = FIXTURE_ALIASES[state.fixture]?.[key];
      const name = alias ?? `${resource}-${type}-${id.replaceAll(':', '_')}`;
      body =
        extra === undefined || alias !== undefined ? fixtureExists(state.fixture, name) : undefined;
    }
    if (body === undefined && resource === 'subtitles' && state.subtitleFiles !== undefined) {
      body = {
        subtitles: Object.entries(state.subtitleFiles).map(([name, file]) => ({
          id: name,
          lang: file.lang,
          url: subtitleUrl(name),
          ...(file.label === undefined ? {} : { label: file.label }),
        })),
      };
    }
    if (body === undefined && state.emptyWhenUnknown === true) body = emptyFor(resource);
    if (body === undefined) {
      respond(res, 404, { err: 'not found' });
      return;
    }
    respond(res, 200, state.mode === 'malformed' ? malform(body) : body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(`${prefix}/`)) {
      respond(res, 404, { err: 'not found' });
      return;
    }
    path = path.slice(prefix.length);
    requests.push(path);
    const latency =
      typeof state.latencyMs === 'function' ? state.latencyMs(path) : (state.latencyMs ?? 0);
    if (latency <= 0) {
      answer(path, res);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) answer(path, res);
    }, latency);
    timers.add(timer);
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;

  return {
    manifestUrl: `${origin}${prefix}/manifest.json`,
    origin,
    requests,
    resourceRequests: () => requests.filter((path) => path !== '/manifest.json'),
    set(changes) {
      Object.assign(state, changes);
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
