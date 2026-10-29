import {
  MultitapEventSchema,
  CreateSessionSchema,
  DEFAULT_RANKING_SETTINGS,
  MB_PER_MINUTE_PER_MBPS,
  RankingSettingsPatchSchema,
  RankingSettingsSchema,
  eventSessionId,
  mergeRankingSettings,
} from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { randomIds, sequentialIds } from '../src/lib/ids.ts';
import { sessionIdentity } from '../src/sessions/identity.ts';

/** Phase 1's constants from rank.ts (removed in phase 2 step 3c), as the defaults must keep them. */
const PHASE1 = {
  tiers: [4000, 3000, 2000, 1000, 10, 100, 300, 20],
  hdr: { noTonemap: 1500, live: 300, prepared: 100 },
  decodeCost: {
    h264_8bit: 0,
    hevc_8bit: 100,
    h264_10bit: 150,
    hevc_10bit: 200,
    vp9: 300,
    av1: 400,
    legacy: 50,
    unknown: 150,
  },
  minMbps: { '2160p': 4, '1080p': 1.5, '720p': 0.8, sd: 0.3 },
  highMbps: 40,
};

describe('DEFAULT_RANKING_SETTINGS', () => {
  it('is valid and equals phase 1 constants, except the raised DV penalty', () => {
    const d = DEFAULT_RANKING_SETTINGS;
    expect(RankingSettingsSchema.parse(d)).toEqual(d);
    expect(Object.values(d.tiers)).toEqual(PHASE1.tiers);
    expect(d.hdr).toEqual({
      noTonemapPenalty: PHASE1.hdr.noTonemap,
      tonemapCostLive: PHASE1.hdr.live,
      tonemapCostPrepared: PHASE1.hdr.prepared,
      dvUnknownProfilePenalty: 1000, // phase 1: 200 (phase 0's change, step 3c)
    });
    expect(d.decodeCost).toEqual(PHASE1.decodeCost);
    expect(d.container).toEqual({ mpegtsLivePenalty: 150, otherPenalty: 25 });
    for (const [cls, mbps] of Object.entries(PHASE1.minMbps)) {
      const range = d.size.perResolution[cls as keyof typeof PHASE1.minMbps];
      expect(range.minMbPerMinute).toBeCloseTo(mbps * MB_PER_MINUTE_PER_MBPS);
      expect(range.maxMbPerMinute).toBe(PHASE1.highMbps * MB_PER_MINUTE_PER_MBPS);
    }
    expect(d.size.tooSmallPenalty).toBe(300);
    expect(d.size.tooLargeLivePenalty).toBe(100);
    expect(d.size.noRuntimeMinMiB).toBe(100);
    // A later preferred language (the per-request list) is new since phase 1.
    expect(d.language).toEqual({ matchBonus: 100, secondaryMatchBonus: 50, mismatchPenalty: 200 });
    // Phase 1 had no 2160p class: 2160 fell into the 1080 one.
    expect(d.resolution).toEqual({
      points: { '2160p': 300, '1080p': 300, '720p': 200, '480p': 100, lower: 0 },
      unknownPoints: 100,
    });
    expect(Object.values(d.release.junkPenalty)).toEqual(Array<number>(5).fill(2500));
    expect(d.release.preparedOnlyPenalty).toBe(200);
  });

  it('merges a partial patch and rejects unknown or invalid fields', () => {
    const patch = RankingSettingsPatchSchema.parse({
      tiers: { http: 3500 },
      size: { perResolution: { '1080p': { maxMbPerMinute: 200 } } },
    });
    const merged = mergeRankingSettings(DEFAULT_RANKING_SETTINGS, patch);
    expect(merged.tiers.http).toBe(3500);
    expect(merged.tiers.debridCached).toBe(4000);
    expect(merged.size.perResolution['1080p']).toEqual({
      minMbPerMinute: 11.25,
      maxMbPerMinute: 200,
    });
    expect(RankingSettingsSchema.parse(merged)).toEqual(merged);
    expect(DEFAULT_RANKING_SETTINGS.tiers.http).toBe(3000); // not mutated

    expect(RankingSettingsPatchSchema.safeParse({ tiers: { htp: 1 } }).success).toBe(false);
    expect(RankingSettingsPatchSchema.safeParse({ nope: {} }).success).toBe(false);
    expect(RankingSettingsPatchSchema.safeParse({ tiers: { http: -1 } }).success).toBe(false);
    expect(RankingSettingsSchema.safeParse({ tiers: DEFAULT_RANKING_SETTINGS.tiers }).success).toBe(
      false,
    );
  });
});

describe('event schemas', () => {
  const at = '2026-09-30T20:00:00.000Z';

  it('accept every declared event type and expose the session id', () => {
    const events = [
      { id: '1', at, type: 'session.status', data: { sessionId: 'ps_1', status: 'resolving' } },
      { id: '2', at, type: 'session.failed', data: { sessionId: 'ps_1', reason: 'unplayable' } },
      { id: '3', at, type: 'session.released', data: { sessionId: 'ps_1', reason: 'retention' } },
      { id: '4', at, type: 'prepare.progress', data: { sessionId: 'ps_1', preparedPct: 50 } },
      { id: '5', at, type: 'prepare.done', data: { sessionId: 'ps_1' } },
      { id: '6', at, type: 'prepare.lost', data: { sessionId: 'ps_1' } },
      { id: '7', at, type: 'prepare.late', data: { sessionId: 'ps_1', readyBy: at } },
      { id: '8', at, type: 'settings.changed', data: { key: 'ranking' } },
      {
        id: '9',
        at,
        type: 'engine.status',
        data: { engineId: 'home', online: false, lastSeen: null },
      },
      {
        id: '10',
        at,
        type: 'streams.partial',
        data: {
          requestId: 'rq_1',
          addon: { addonId: 'a', addonName: 'A', status: 'ok', count: 0, dropped: 0 },
          candidates: [],
          remaining: 0,
        },
      },
    ];
    for (const event of events) {
      const parsed = MultitapEventSchema.parse(event);
      expect(eventSessionId(parsed)).toBe(
        'sessionId' in event.data ? event.data.sessionId : undefined,
      );
    }
    expect(
      MultitapEventSchema.safeParse({ id: '1', at, type: 'session.status', data: { status: 'x' } })
        .success,
    ).toBe(false);
    expect(MultitapEventSchema.safeParse({ id: '1', at, type: 'nope', data: {} }).success).toBe(
      false,
    );
  });
});

describe('session contracts', () => {
  it('bounds quality and accepts both source forms', () => {
    const base = { item: { type: 'movie', id: 'tt1375666' } };
    expect(CreateSessionSchema.safeParse({ ...base, source: { key: 'k' } }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ ...base, source: { auto: true } }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ ...base, source: { auto: false } }).success).toBe(false);
    for (const quality of [{ maxHeight: 100 }, { maxHeight: 4320 }, { bitrate: 99_999 }]) {
      expect(
        CreateSessionSchema.safeParse({ ...base, source: { key: 'k' }, quality }).success,
      ).toBe(false);
    }
  });

  it('identity depends on every identity part and nothing else', () => {
    const parts = {
      key: 'room:abc',
      item: { type: 'series', id: 'tt0903747', videoId: 'tt0903747:1:1' },
      source: { key: 'k1' },
      delivery: 'auto' as const,
      quality: { maxHeight: 720 },
    };
    const id = sessionIdentity(parts);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionIdentity({ ...parts })).toBe(id);
    expect(sessionIdentity({ ...parts, key: undefined })).toBeNull();
    for (const changed of [
      { key: 'room:xyz' },
      { item: { ...parts.item, videoId: 'tt0903747:1:2' } },
      { source: { auto: true as const } },
      { delivery: 'transcode' as const },
      { quality: { maxHeight: 1080 } },
      { quality: undefined },
    ]) {
      expect(sessionIdentity({ ...parts, ...changed })).not.toBe(id);
    }
  });
});

describe('id generators', () => {
  it('produce the documented formats', () => {
    expect(randomIds.playbackSession()).toMatch(/^ps_[A-Za-z0-9_-]{22}$/);
    expect(randomIds.engineSession()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomIds.profile()).toMatch(/^pr_[A-Za-z0-9_-]{22}$/);
    expect(randomIds.request()).toMatch(/^rq_[A-Za-z0-9_-]{22}$/);
    const ids = sequentialIds();
    expect(ids.playbackSession()).toBe('ps_S000000000000000000001');
    expect(ids.playbackSession()).toBe('ps_S000000000000000000002');
    expect(ids.engineSession()).toBe('E000000000000000000001');
    expect(ids.engineSession()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
