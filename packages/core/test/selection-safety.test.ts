/**
 * Safety flags and uncached debrid sources (okf:decision/destructive-items-flagged), found in a
 * real MediaFusion test: a debrid watchlist lists "delete all files" as an
 * item, and uncached sources (⏳) ranked like plain HTTP. Uses a synthetic
 * MediaFusion-style addon (`fixtures/debrid-addon-synthetic.json`), the real
 * redacted Torrentio RD responses, and the session rig. No network beyond
 * localhost, no ffmpeg.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CatalogPageSchema,
  DEFAULT_RANKING_SETTINGS,
  MetaResultSchema,
  RankingSettingsSchema,
  SourceListSchema,
  mergeRankingSettings,
  type RankingSettings,
  type SourceCandidate,
} from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import { HOME_ENGINE, addHomeEngine } from './engine-fixture.ts';
import { createApp } from '../src/http/app.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import { toCandidates } from '../src/selection/candidates.ts';
import { debridCached } from '../src/selection/parse/extractors.ts';
import { annotate, sortByRank } from '../src/selection/rank.ts';
import { RankingSettingsStore } from '../src/selection/ranking-settings.ts';
import { itemFlagReasons, matchTitlePattern } from '../src/selection/safety.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { startFakeAddon, type FakeAddon } from './fakes/addon.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';
import { realStreams } from './selection-fixtures.ts';
import { httpStream, MOVIE, sessionRig, type Rig } from './session-setup.ts';

interface SyntheticFixture {
  manifest: Record<string, unknown>;
  catalog: unknown;
  meta: unknown;
  deleteStreams: { streams: unknown[] };
  movieStreams: { streams: unknown[] };
}

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/debrid-addon-synthetic.json'), 'utf8'),
) as SyntheticFixture;

const DELETE_ID = 'dlsynthetic_9f2c';
const SAFETY = DEFAULT_RANKING_SETTINGS.safety;
const ENGINE = { id: 'home', capabilities: HOME_ENGINE.capabilities };

// ---- Pattern matching ---------------------------------------------------------------------

describe('safety title patterns (defaults)', () => {
  it.each([
    ['🗑️💩 Delete all files', 'delete all'],
    ['DELETE ALL', 'delete all'],
    ['delete   all torrents', 'delete all'],
    ['Remove all downloads', 'remove all'],
    ['Clear all', 'clear all'],
    ['Wipe the account', 'wipe'],
    ['⚠️ Purge all', 'purge all'],
    ['Format', 'format'],
    ['[Format] drive', 'format'],
    ['Big Buck Bunny', undefined],
    ['Wipeout (2016)', undefined],
    ['Information', undefined],
    ['Deleted all scenes', undefined],
    ['Formation World Tour', undefined],
    ['Movie.2026.1080p.WEB-DL.H264-GRP.mkv', undefined],
    ['', undefined],
  ])('%j → %j', (title, pattern) => {
    expect(matchTitlePattern(title, SAFETY)).toBe(pattern);
  });

  it('treats patterns as plain text and ids by prefix', () => {
    const safety = { titlePatterns: ['a.b (c)'], idPrefixes: ['dlsynthetic_9'] };
    expect(matchTitlePattern('x a.b (c) y', safety)).toBe('a.b (c)');
    expect(matchTitlePattern('aXb (c)', safety)).toBeUndefined();
    expect(itemFlagReasons({ id: DELETE_ID }, safety)).toEqual([
      { flag: 'destructive', rule: 'safety.idPrefixes', detail: 'item id' },
    ]);
    expect(itemFlagReasons({ id: 'dlsynthetic_51ab', name: 'Big Buck Bunny' }, safety)).toEqual([]);
  });
});

// ---- Uncached markers ---------------------------------------------------------------------

describe('uncached debrid markers', () => {
  it.each([
    ['Synthetic RD ⏳ 1080p', false],
    ['Synthetic RD ⌛ 720p', false],
    ['[RD download] Torrentio\n1080p', false],
    ['Synthetic RD ⚡️ 1080p', true],
    ['[RD+] Torrentio\n4k', true],
    ['Synthetic 1080p', undefined],
  ])('%j → cached %j', (label, cached) => {
    expect(debridCached(label)).toBe(cached);
  });

  it('every real Torrentio RD source is cached or unknown, never uncached', () => {
    const made = toCandidates({ id: 'rd', name: 'Torrentio RD' }, realStreams('torrentio-rd'));
    expect(made.length).toBeGreaterThan(0);
    for (const { candidate } of made) {
      expect(candidate.parsed.cached).not.toBe(false);
      // Phase 2 parsed Torrentio's `[RD+]` as cached already.
      if (candidate.name.startsWith('[RD+]')) expect(candidate.parsed.cached).toBe(true);
    }
  });
});

// ---- Ranking -----------------------------------------------------------------------------

function rankSynthetic(settings: RankingSettings = DEFAULT_RANKING_SETTINGS): SourceCandidate[] {
  const streams = FIXTURE.movieStreams.streams.map((s) => StreamSchema.parse(s));
  const made = toCandidates({ id: 'synthetic', name: 'Synthetic Debrid' }, streams);
  const healthyTorrent = toCandidates({ id: 'p2p', name: 'P2P' }, [
    StreamSchema.parse({
      infoHash: '3333333333333333333333333333333333333333',
      fileIdx: 0,
      name: 'P2P\n1080p',
      title: 'Movie.2026.1080p.WEB-DL.H264-P2P.mkv\n👤 40 💾 4 GB',
    }),
  ]);
  const candidates = [...made, ...healthyTorrent].map((m) => m.candidate);
  return annotate(candidates, ENGINE, 'off', { settings, explain: true });
}

describe('uncached penalty (debrid.uncachedPenalty)', () => {
  it('ranks cached debrid, then a healthy torrent, then uncached; uncached stays playable', () => {
    const ranked = sortByRank(rankSynthetic());
    expect(ranked.map((c) => [c.name.split('\n')[0], c.parsed.cached])).toEqual([
      ['Synthetic RD ⚡️ 1080p', true],
      ['P2P', undefined],
      ['Synthetic RD ⏳ 1080p', false],
      ['[RD download] Synthetic', false],
    ]);
    for (const c of ranked) expect(c.playable).toBe(true);
    const uncached = ranked[2];
    const rules = uncached?.explain?.contributions.map((c) => [c.rule, c.points]);
    expect(rules).toContainEqual(['tier', DEFAULT_RANKING_SETTINGS.tiers.http]);
    expect(rules).toContainEqual(['uncached', -DEFAULT_RANKING_SETTINGS.debrid.uncachedPenalty]);
    expect(uncached?.explain?.weights['debrid.uncachedPenalty']).toBe(2000);
    // The cached one has no `uncached` move.
    expect(ranked[0]?.explain?.contributions.map((c) => c.rule)).not.toContain('uncached');
  });

  it('follows the setting: 0 ranks an uncached link like plain HTTP again', () => {
    const settings = mergeRankingSettings(DEFAULT_RANKING_SETTINGS, {
      debrid: { uncachedPenalty: 0 },
    });
    const ranked = sortByRank(rankSynthetic(settings));
    expect(ranked[1]?.name).toBe('Synthetic RD ⏳ 1080p');
    expect(ranked[1]?.explain?.contributions.map((c) => c.rule)).not.toContain('uncached');
  });

  it('keeps phase 2 scores for `[RD download]` with the defaults (http tier minus the penalty)', () => {
    const { tiers, debrid } = DEFAULT_RANKING_SETTINGS;
    expect(tiers.http - debrid.uncachedPenalty).toBe(tiers.weakTorrent);
  });
});

describe('flags in annotate', () => {
  it('flags by the source text or the item, without changing the score', () => {
    const streams = [
      httpStream('one'),
      { url: 'https://media.example/x.mkv', name: 'Addon', title: 'Delete all files' },
    ].map((s) => StreamSchema.parse(s));
    const candidates = toCandidates({ id: 'a', name: 'A' }, streams).map((m) => m.candidate);
    const settings = DEFAULT_RANKING_SETTINGS;
    const plain = annotate(candidates, ENGINE, 'off', { settings, explain: true });
    expect(plain[0]?.flags).toBeUndefined();
    expect(plain[0]?.explain?.flags).toBeUndefined();
    expect(plain[1]?.flags).toEqual(['destructive']);
    expect(plain[1]?.explain?.flags).toEqual([
      {
        flag: 'destructive',
        rule: 'safety.titlePatterns',
        detail: "source description: 'delete all'",
      },
    ]);
    const byItem = annotate(candidates, ENGINE, 'off', {
      settings,
      itemFlagReasons: itemFlagReasons({ name: '🗑️💩 Delete all files' }, SAFETY),
    });
    expect(byItem.map((c) => c.flags)).toEqual([['destructive'], ['destructive']]);
    expect(byItem.map((c) => c.score)).toEqual(plain.map((c) => c.score));
    // Re-annotating with no match clears an old flag.
    const empty = { ...settings, safety: { titlePatterns: [], idPrefixes: [] } };
    expect(annotate(byItem, ENGINE, 'off', { settings: empty }).map((c) => c.flags)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

// ---- Settings ----------------------------------------------------------------------------

describe('safety and debrid settings', () => {
  it('are later groups: patchable, validated, and equal lists are no override', async () => {
    const store = new RankingSettingsStore({ db: await migratedMemoryDb(), clock: manualClock() });
    expect(RankingSettingsSchema.parse(DEFAULT_RANKING_SETTINGS)).toEqual(DEFAULT_RANKING_SETTINGS);
    let view = await store.patch({ safety: { idPrefixes: ['dlsynthetic_9'] } });
    expect(view.overrides).toEqual({ safety: { idPrefixes: ['dlsynthetic_9'] } });
    expect(view.effective.safety.titlePatterns).toEqual(SAFETY.titlePatterns);
    view = await store.patch({
      safety: { idPrefixes: [], titlePatterns: [...SAFETY.titlePatterns] },
    });
    expect(view.overrides).toEqual({});
    await expect(store.patch({ safety: { titlePatterns: ['  '] } })).rejects.toThrow();
    await expect(store.patch({ debrid: { uncachedPenalty: -1 } })).rejects.toThrow();
  });
});

// ---- HTTP: catalog, meta, streams ---------------------------------------------------------

const fakes: FakeAddon[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function httpSetup() {
  const db = await migratedMemoryDb();
  await addHomeEngine(db);
  const log = memoryLogger('info');
  const clock = manualClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '1000',
    MULTITAP_ADDON_TIMEOUT_META_MS: '1000',
    MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '1000',
  });
  const addons = new AddonService({ config, db, logger: log.logger, clock });
  const ranking = new RankingSettingsStore({ db, clock });
  const app = createApp({
    config,
    db,
    logger: log.logger,
    clock,
    addons,
    ranking,
    streams: new StreamStore({ clock }),
    subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
    metrics: new MetricsRegistry(),
  });
  const key = (await createApiKey(db, { scope: 'client', label: 'client' }, clock)).key;
  const fake = await startFakeAddon({
    fixture: 'torrentio-rd',
    manifest: FIXTURE.manifest,
    routes: {
      'catalog/movie/synthetic_watchlist': FIXTURE.catalog,
      [`meta/movie/${DELETE_ID}`]: FIXTURE.meta,
      [`stream/movie/${DELETE_ID}`]: FIXTURE.deleteStreams,
      [`stream/movie/${MOVIE.id}`]: FIXTURE.movieStreams,
    },
    emptyWhenUnknown: true,
  });
  fakes.push(fake);
  const record = await addons.collection.add(fake.manifestUrl);
  const get = async (path: string) => {
    const res = await app.request(path, { headers: bearer(key) });
    return { status: res.status, body: await res.json() };
  };
  return { get, record, ranking, log };
}

describe('flags over HTTP', () => {
  it('flags the catalog item and its meta; leaves the others alone', async () => {
    const t = await httpSetup();
    const page = CatalogPageSchema.parse(
      (await t.get(`/v1/catalog/${t.record.id}/movie/synthetic_watchlist`)).body,
    );
    expect(page.metas.map((m) => [m.name, m.flags])).toEqual([
      ['🗑️💩 Delete all files', ['destructive']],
      ['Big Buck Bunny', undefined],
      ['Wipeout Information', undefined],
    ]);
    const meta = MetaResultSchema.parse((await t.get(`/v1/meta/movie/${DELETE_ID}`)).body);
    expect(meta.meta.flags).toEqual(['destructive']);
  });

  it('lists the item’s sources annotated, never hidden, with the reason in explain', async () => {
    const t = await httpSetup();
    const res = await t.get(`/v1/streams/movie/${DELETE_ID}?explain=true`);
    expect(res.status).toBe(200);
    const list = SourceListSchema.parse(res.body);
    expect(list.candidates).toHaveLength(1);
    const [only] = list.candidates;
    expect(only?.flags).toEqual(['destructive']);
    expect(only?.playable).toBe(true);
    expect(only?.explain?.flags).toEqual([
      { flag: 'destructive', rule: 'safety.titlePatterns', detail: "item name: 'delete all'" },
    ]);
    // Nothing URL-like in the reasons.
    expect(JSON.stringify(only?.explain)).not.toContain('example.invalid');
  });

  it('flags by id prefix once configured', async () => {
    const t = await httpSetup();
    await t.ranking.patch({ safety: { titlePatterns: [], idPrefixes: ['dlsynthetic_9'] } });
    const list = SourceListSchema.parse(
      (await t.get(`/v1/streams/movie/${DELETE_ID}?explain=true`)).body,
    );
    expect(list.candidates[0]?.explain?.flags).toEqual([
      { flag: 'destructive', rule: 'safety.idPrefixes', detail: 'item id' },
    ]);
    const page = CatalogPageSchema.parse(
      (await t.get(`/v1/catalog/${t.record.id}/movie/synthetic_watchlist`)).body,
    );
    expect(page.metas.map((m) => m.flags)).toEqual([['destructive'], undefined, undefined]);
  });

  it('ranks cached MediaFusion-style sources above uncached ones', async () => {
    const t = await httpSetup();
    const list = SourceListSchema.parse(
      (await t.get(`/v1/streams/movie/${MOVIE.id}?sort=rank`)).body,
    );
    expect(list.candidates.map((c) => [c.parsed.cached, c.flags])).toEqual([
      [true, undefined],
      [false, undefined],
      [false, undefined],
    ]);
  });
});

// ---- Sessions: auto-select and a picked source --------------------------------------------

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.service.stop();
    await rig.settle();
    await rig.db.destroy();
  }
});

async function rig() {
  const r = await sessionRig();
  rigs.push(r);
  return r;
}

describe('auto-select skips flagged sources', () => {
  it('plays the best unflagged source even when a flagged one ranks higher', async () => {
    const r = await rig();
    const [flagged, plain] = r.auto(httpStream('flagged'), httpStream('plain'));
    if (flagged === undefined || plain === undefined) throw new Error('not listed');
    flagged.flags = ['destructive'];
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    const done = await r.service.get(session.id);
    expect(done).toMatchObject({ status: 'ready', chosen: plain.key });
    expect(done?.candidates?.map((c) => c.key)).toEqual([plain.key]);
    expect(r.fake.masterRequests).toHaveLength(1);
  });

  it('fails with only-flagged when every playable source is flagged', async () => {
    const r = await rig();
    const [flagged] = r.auto(httpStream('flagged'));
    if (flagged === undefined) throw new Error('not listed');
    flagged.flags = ['destructive'];
    const { session } = await r.service.create({ item: MOVIE, source: { auto: true } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({
      status: 'failed',
      failureReason: 'only-flagged',
    });
    expect(r.fake.masterRequests).toHaveLength(0);
  });

  it('plays a picked flagged source, with a warning that carries no URL', async () => {
    const r = await rig();
    const key = r.list(httpStream('flagged'));
    const stored = r.streams.get(key);
    if (stored === undefined) throw new Error('not listed');
    r.streams.put(key, { ...stored, flags: ['destructive'] });
    const { session } = await r.service.create({ item: MOVIE, source: { key } });
    await r.settle();
    expect(await r.service.get(session.id)).toMatchObject({ status: 'ready', chosen: key });
    const warning = r.log
      .lines()
      .find((l) => l.msg === 'picked source is flagged; playing it as asked');
    expect(warning).toMatchObject({ key, flags: ['destructive'] });
    expect(r.log.text()).not.toContain('media.example');
  });
});
