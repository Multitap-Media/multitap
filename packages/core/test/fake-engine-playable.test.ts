/**
 * The fake engine's opt-in `playableMedia` mode: the committed test-pattern
 * clip served through `/hlsv2/{sid}/{file}`, and the per-segment delay. Offline:
 * nothing here runs ffmpeg.
 */
import { describe, expect, it } from 'vitest';
import {
  FAKE_SEGMENT_SECONDS,
  FakeEngine,
  loadPlayableClip,
  type FakeEngineOptions,
} from './fakes/engine.ts';
import { applyStackCommand, playableRepeatFromEnv } from './harness/stack.ts';

const MEDIA = 'https://media.example/movie.mkv';
const SID = 'room-1';

async function start(options: FakeEngineOptions): Promise<FakeEngine> {
  const fake = new FakeEngine(options);
  const res = await fake.app.request(
    `/hlsv2/${SID}/master.m3u8?mediaURL=${encodeURIComponent(MEDIA)}`,
  );
  expect(res.status).toBe(200);
  return fake;
}

async function text(fake: FakeEngine, file: string): Promise<string> {
  const res = await fake.app.request(`/hlsv2/${SID}/${file}`);
  expect(res.status).toBe(200);
  return res.text();
}

async function bytes(fake: FakeEngine, file: string): Promise<Uint8Array> {
  const res = await fake.app.request(`/hlsv2/${SID}/${file}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('video/mp2t');
  return new Uint8Array(await res.arrayBuffer());
}

function expectTransportStream(data: Uint8Array): void {
  expect(data.length).toBeGreaterThan(0);
  expect(data.length % 188).toBe(0);
  for (let i = 0; i < data.length; i += 188) expect(data[i]).toBe(0x47);
}

describe('fake engine, default mode', () => {
  it('serves the synthetic 2-minute playlist and ten-packet segments, as before', async () => {
    const fake = await start({});
    expect(fake.options.playableMedia).toBe(false);
    expect(fake.options.defaultProbe).toBe('sdr-1080p');
    const playlist = await text(fake, 'playlist.m3u8');
    expect(playlist.match(/^#EXTINF:/gm)).toHaveLength(30);
    const body = await bytes(fake, 'seg3.ts');
    expect(body.length).toBe(1880);
    expect(new TextDecoder().decode(body.subarray(1, 1 + `${SID}/seg3.ts`.length))).toBe(
      `${SID}/seg3.ts`,
    );
  });
});

describe('fake engine, playableMedia', () => {
  it('lists the clip’s real segments with their durations', async () => {
    const clip = loadPlayableClip();
    expect(clip.segments).toHaveLength(30);
    expect(clip.duration).toBe(120);
    const fake = await start({ playableMedia: true });
    expect(fake.probeFor(MEDIA).duration).toBe(clip.duration);
    const playlist = await text(fake, 'playlist.m3u8');
    const lines = playlist.trim().split('\n');
    expect(lines).toContain(`#EXT-X-TARGETDURATION:${String(FAKE_SEGMENT_SECONDS)}`);
    expect(lines.at(-1)).toBe('#EXT-X-ENDLIST');
    const entries = lines.flatMap((l, i) =>
      l.startsWith('#EXTINF:') ? [{ d: Number(l.slice(8, -1)), uri: lines[i + 1] }] : [],
    );
    expect(entries.map((e) => e.uri)).toEqual(clip.segments.map((_, i) => `seg${String(i)}.ts`));
    expect(entries.map((e) => e.d)).toEqual(clip.durations);
    expect(entries.reduce((a, e) => a + e.d, 0)).toBeCloseTo(120, 3);
  });

  it('serves the committed segment bytes as valid MPEG-TS', async () => {
    const clip = loadPlayableClip();
    const fake = await start({ playableMedia: true });
    for (const n of [0, 1, 29]) {
      const data = await bytes(fake, `seg${String(n)}.ts`);
      expectTransportStream(data);
      expect(data).toEqual(clip.segments[n]);
    }
    expect((await bytes(fake, 'seg0.ts')).length).toBeGreaterThan(10_000);
    const missing = await fake.app.request(`/hlsv2/${SID}/seg30.ts`);
    expect(missing.status).toBe(404);
  });

  it('delays one named segment on top of segmentLatencyMs', async () => {
    const fake = await start({
      playableMedia: true,
      segmentLatencyMs: 0,
      segmentDelays: { 'seg2.ts': 250 },
    });
    const time = async (file: string) => {
      const t0 = performance.now();
      await bytes(fake, file);
      return performance.now() - t0;
    };
    expect(await time('seg1.ts')).toBeLessThan(150);
    expect(await time('seg2.ts')).toBeGreaterThanOrEqual(240);
    // A runtime delay for one session's segment, and clearing it.
    fake.segmentDelays.set(`${SID}/seg1.ts`, 200);
    expect(await time('seg1.ts')).toBeGreaterThanOrEqual(190);
    fake.segmentDelays.clear();
    expect(await time('seg2.ts')).toBeLessThan(150);
  });

  it('adds the per-segment delay to the base latency', async () => {
    const fake = await start({ playableMedia: true, segmentLatencyMs: 100 });
    fake.segmentDelays.set('seg0.ts', 150);
    const t0 = performance.now();
    await bytes(fake, 'seg0.ts');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(240);
  });
});

describe('fake engine, playableRepeat', () => {
  it('lists the clip N times with a discontinuity before each later copy', async () => {
    const clip = loadPlayableClip();
    const fake = await start({ playableMedia: true, playableRepeat: 3 });
    expect(fake.probeFor(MEDIA).duration).toBe(clip.duration * 3);
    const lines = (await text(fake, 'playlist.m3u8')).trim().split('\n');
    expect(lines).toContain(`#EXT-X-TARGETDURATION:${String(FAKE_SEGMENT_SECONDS)}`);
    expect(lines).toContain('#EXT-X-VERSION:4');
    expect(lines.filter((l) => l === '#EXT-X-DISCONTINUITY')).toHaveLength(2);
    const entries = lines.flatMap((l, i) =>
      l.startsWith('#EXTINF:') ? [{ d: Number(l.slice(8, -1)), uri: lines[i + 1] }] : [],
    );
    expect(entries).toHaveLength(90);
    expect(entries.map((e) => e.uri)).toEqual(
      Array.from({ length: 90 }, (_, i) => `seg${String(i)}.ts`),
    );
    expect(entries.map((e) => e.d)).toEqual([
      ...clip.durations,
      ...clip.durations,
      ...clip.durations,
    ]);
    expect(entries.reduce((a, e) => a + e.d, 0)).toBeCloseTo(360, 3);
    // The tag sits right before the first segment of each copy.
    for (const first of [30, 60]) {
      const at = lines.indexOf(`seg${String(first)}.ts`);
      expect(lines[at - 2]).toBe('#EXT-X-DISCONTINUITY');
    }
    expect(lines.at(-1)).toBe('#EXT-X-ENDLIST');
  });

  it('serves segment i as the clip’s i % 30 and 404s past the end', async () => {
    const clip = loadPlayableClip();
    const fake = await start({ playableMedia: true, playableRepeat: 2 });
    for (const n of [0, 30, 45, 59]) {
      expect(await bytes(fake, `seg${String(n)}.ts`)).toEqual(clip.segments[n % 30]);
    }
    expect((await fake.app.request(`/hlsv2/${SID}/seg60.ts`)).status).toBe(404);
  });

  it('is unchanged by default and for a repeat of 1', async () => {
    for (const options of [{ playableMedia: true }, { playableMedia: true, playableRepeat: 1 }]) {
      const fake = await start(options);
      expect(fake.probeFor(MEDIA).duration).toBe(120);
      const playlist = await text(fake, 'playlist.m3u8');
      expect(playlist).not.toContain('DISCONTINUITY');
      expect(playlist.match(/^#EXTINF:/gm)).toHaveLength(30);
      expect((await fake.app.request(`/hlsv2/${SID}/seg30.ts`)).status).toBe(404);
    }
  });
});

describe('stack stdin commands', () => {
  it('sets and clears segment delays', () => {
    const engine = { segmentDelays: new Map<string, number>() };
    expect(applyStackCommand(engine, '{"delay":{"segment":"seg5.ts","ms":3000}}')).toBeUndefined();
    expect(engine.segmentDelays.get('seg5.ts')).toBe(3000);
    expect(applyStackCommand(engine, '{"delay":{"clear":true}}')).toBeUndefined();
    expect(engine.segmentDelays.size).toBe(0);
  });

  it('rejects bad lines without changing anything', () => {
    const engine = { segmentDelays: new Map<string, number>() };
    for (const line of [
      'nope',
      '{}',
      'null',
      '{"delay":{"segment":"a.ts"}}',
      '{"delay":{"segment":"a.ts","ms":-1}}',
    ]) {
      expect(applyStackCommand(engine, line)).toBeTypeOf('string');
    }
    expect(engine.segmentDelays.size).toBe(0);
  });

  it('reads the repeat from the environment, defaulting to 6', () => {
    expect(playableRepeatFromEnv(undefined)).toBe(6);
    expect(playableRepeatFromEnv('2')).toBe(2);
    expect(playableRepeatFromEnv('0')).toBe(6);
    expect(playableRepeatFromEnv('x')).toBe(6);
  });
});
