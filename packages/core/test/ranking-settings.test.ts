import {
  MultitapEventSchema,
  DEFAULT_RANKING_SETTINGS,
  RankingSettingsViewSchema,
  mergeRankingSettings,
  type MultitapEventInput,
  type RankingSettings,
} from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { AddonService } from '../src/addons/index.ts';
import { createApiKey } from '../src/auth/keys.ts';
import { loadConfig } from '../src/config.ts';
import type { EventBus } from '../src/events/bus.ts';
import { createApp } from '../src/http/app.ts';
import { MetricsRegistry } from '../src/metrics/index.ts';
import {
  RankingSettingsError,
  RankingSettingsStore,
  diffSettings,
} from '../src/selection/ranking-settings.ts';
import { StreamStore } from '../src/selection/stream-store.ts';
import { SubtitleService } from '../src/subtitles/index.ts';
import { bearer, manualClock, memoryLogger, migratedMemoryDb } from './helpers.ts';

/** Collects published events, validated against their schemas. */
function recordingBus(): Pick<EventBus, 'publish'> & { events: MultitapEventInput[] } {
  const events: MultitapEventInput[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
      const stored = { ...event, id: String(events.length), at: new Date(0).toISOString() };
      return MultitapEventSchema.parse(stored);
    },
  };
}

async function storedRows(db: Awaited<ReturnType<typeof migratedMemoryDb>>) {
  return db.selectFrom('settings').selectAll().execute();
}

describe('RankingSettingsStore', () => {
  it('starts at the defaults, stores only overrides, and reset removes them', async () => {
    const db = await migratedMemoryDb();
    const bus = recordingBus();
    const store = new RankingSettingsStore({ db, clock: manualClock(), events: bus });
    expect(await store.effective()).toEqual(DEFAULT_RANKING_SETTINGS);

    const view = await store.patch({ tiers: { http: 3500 }, hdr: { noTonemapPenalty: 1500 } });
    // 1500 is the default: not an override.
    expect(view.overrides).toEqual({ tiers: { http: 3500 } });
    expect(view.effective.tiers.http).toBe(3500);
    const rows = await storedRows(db);
    expect(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown])).toEqual([
      ['ranking', { tiers: { http: 3500 } }],
    ]);

    // A second store over the same database loads the overrides.
    const reloaded = new RankingSettingsStore({ db, clock: manualClock() });
    expect((await reloaded.effective()).tiers.http).toBe(3500);

    const reset = await store.reset();
    expect(reset.effective).toEqual(DEFAULT_RANKING_SETTINGS);
    expect(reset.overrides).toEqual({});
    expect(await storedRows(db)).toEqual([]);
    expect(bus.events).toEqual([
      { type: 'settings.changed', data: { key: 'ranking' } },
      { type: 'settings.changed', data: { key: 'ranking' } },
    ]);
  });

  it('patches merge over the previous write, in order', async () => {
    const store = new RankingSettingsStore({ db: await migratedMemoryDb(), clock: manualClock() });
    await Promise.all([
      store.patch({ tiers: { http: 3100 } }),
      store.patch({ tiers: { weakTorrent: 900 } }),
    ]);
    expect((await store.view()).overrides).toEqual({ tiers: { http: 3100, weakTorrent: 900 } });
  });

  it('rejects an invalid document and stores nothing', async () => {
    const db = await migratedMemoryDb();
    const bus = recordingBus();
    const store = new RankingSettingsStore({ db, clock: manualClock(), events: bus });
    const bad = {
      ...DEFAULT_RANKING_SETTINGS,
      tiers: { ...DEFAULT_RANKING_SETTINGS.tiers, http: -1 },
    };
    await expect(store.replace(bad)).rejects.toBeInstanceOf(RankingSettingsError);
    expect(await storedRows(db)).toEqual([]);
    expect(await store.effective()).toEqual(DEFAULT_RANKING_SETTINGS);
    expect(bus.events).toEqual([]);
  });

  it('ignores a broken stored row and ranks with the defaults', async () => {
    const db = await migratedMemoryDb();
    await db
      .insertInto('settings')
      .values({ key: 'ranking', value_json: '{"tiers":{"http":"lots"}}', updated_at: 0 })
      .execute();
    const log = memoryLogger();
    const store = new RankingSettingsStore({ db, clock: manualClock(), logger: log.logger });
    expect(await store.effective()).toEqual(DEFAULT_RANKING_SETTINGS);
    expect(log.text()).toContain('stored ranking settings are invalid');
  });

  it('diffSettings keeps only changed leaves', () => {
    const changed = mergeRankingSettings(DEFAULT_RANKING_SETTINGS, {
      size: { perResolution: { '720p': { maxMbPerMinute: 120 } } },
    });
    expect(diffSettings(DEFAULT_RANKING_SETTINGS, changed)).toEqual({
      size: { perResolution: { '720p': { maxMbPerMinute: 120 } } },
    });
    expect(diffSettings(DEFAULT_RANKING_SETTINGS, DEFAULT_RANKING_SETTINGS)).toBeUndefined();
  });
});

describe('/v1/admin/ranking', () => {
  async function setup() {
    const db = await migratedMemoryDb();
    const log = memoryLogger();
    const clock = manualClock();
    const config = loadConfig({ NODE_ENV: 'test' });
    const addons = new AddonService({ config, db, logger: log.logger, clock });
    const bus = recordingBus();
    const ranking = new RankingSettingsStore({ db, clock, logger: log.logger, events: bus });
    const app = createApp({
      config,
      db,
      logger: log.logger,
      clock,
      addons,
      streams: new StreamStore({ clock }),
      subtitles: new SubtitleService({ addons, clock, logger: log.logger }),
      metrics: new MetricsRegistry(),
      ranking,
    });
    const admin = (await createApiKey(db, { scope: 'admin', label: 'a' }, clock)).key;
    const client = (await createApiKey(db, { scope: 'client', label: 'c' }, clock)).key;
    const call = (method: string, key: string, body?: unknown) =>
      app.request('/v1/admin/ranking', {
        method,
        headers: { ...bearer(key), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { db, bus, ranking, call, admin, client };
  }

  it('GET shows effective, defaults and overrides; admin scope only', async () => {
    const { call, admin, client } = await setup();
    const res = await call('GET', admin);
    expect(res.status).toBe(200);
    const view = RankingSettingsViewSchema.parse(await res.json());
    expect(view).toEqual({
      effective: DEFAULT_RANKING_SETTINGS,
      defaults: DEFAULT_RANKING_SETTINGS,
      overrides: {},
    });
    expect((await call('GET', client)).status).toBe(403);
  });

  it('PATCH changes some, PUT replaces all, DELETE resets; each emits settings.changed', async () => {
    const { call, admin, bus, ranking } = await setup();
    const patched = await call('PATCH', admin, { language: { matchBonus: 250 } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { overrides: unknown }).overrides).toEqual({
      language: { matchBonus: 250 },
    });
    expect((await ranking.effective()).language.matchBonus).toBe(250);

    // PUT imports a complete preset: the earlier patch is gone.
    const preset: RankingSettings = mergeRankingSettings(DEFAULT_RANKING_SETTINGS, {
      tiers: { http: 3900 },
    });
    const put = await call('PUT', admin, preset);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { overrides: unknown }).overrides).toEqual({
      tiers: { http: 3900 },
    });

    const reset = await call('DELETE', admin);
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { effective: unknown }).effective).toEqual(
      DEFAULT_RANKING_SETTINGS,
    );
    expect(await ranking.effective()).toEqual(DEFAULT_RANKING_SETTINGS);
    expect(bus.events.map((e) => e.type)).toEqual([
      'settings.changed',
      'settings.changed',
      'settings.changed',
    ]);
  });

  it('PUT takes an older preset without the later groups (binge, lastSource, debrid, safety): they take the defaults', async () => {
    const { call, admin, ranking } = await setup();
    const preset: Partial<RankingSettings> = mergeRankingSettings(DEFAULT_RANKING_SETTINGS, {
      tiers: { http: 3900 },
    });
    delete preset.binge;
    delete preset.lastSource;
    delete preset.debrid;
    delete preset.safety;
    const put = await call('PUT', admin, preset);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { overrides: unknown }).overrides).toEqual({
      tiers: { http: 3900 },
    });
    const effective = await ranking.effective();
    expect(effective.binge).toEqual(DEFAULT_RANKING_SETTINGS.binge);
    expect(effective.lastSource).toEqual(DEFAULT_RANKING_SETTINGS.lastSource);
    expect(effective.debrid).toEqual(DEFAULT_RANKING_SETTINGS.debrid);
    expect(effective.safety).toEqual(DEFAULT_RANKING_SETTINGS.safety);
    // An older group still can't be left out, and the later ones are validated when given.
    const noLanguage: Partial<RankingSettings> = { ...DEFAULT_RANKING_SETTINGS };
    delete noLanguage.language;
    expect((await call('PUT', admin, noLanguage)).status).toBe(400);
    const badLater = { ...DEFAULT_RANKING_SETTINGS, lastSource: { matchBonus: -1 } };
    expect((await call('PUT', admin, badLater)).status).toBe(400);
  });

  it.each([
    ['PATCH', { tiers: { htp: 1 } }],
    ['PATCH', { tiers: { http: -5 } }],
    ['PATCH', { nope: {} }],
    ['PUT', { tiers: DEFAULT_RANKING_SETTINGS.tiers }],
    ['PUT', 'not json'],
  ])('%s with an invalid body is a 400 and stores nothing', async (method, body) => {
    const { call, admin, db, bus } = await setup();
    const res = await call(method, admin, body);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await storedRows(db)).toEqual([]);
    expect(bus.events).toEqual([]);
  });
});
