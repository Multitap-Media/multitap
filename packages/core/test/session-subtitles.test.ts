/**
 * The gateway's session subtitles (okf:architecture/core-subtitles-and-player-state) against a fake subtitle service:
 * two sessions of one item keep each other's tracks, a listing made because
 * nothing is remembered uses the session's hints, a file the service forgot
 * is listed again, concurrent misses share one listing, and offsets are read
 * from memory but follow every write.
 */
import type { SubtitleList } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { SessionSubtitles } from '../src/gateway/subtitles.ts';
import type { PlaybackSessionRecord } from '../src/sessions/repository.ts';
import { SubtitleFileError, type SubtitleHints } from '../src/subtitles/index.ts';
import { manualClock } from './helpers.ts';

const ITEM = { type: 'movie', id: 'tt0000001' };
const A_FILE = 'A'.repeat(32);
const B_FILE = 'B'.repeat(32);
const SHARED_FILE = 'S'.repeat(32);

const session = (id: string): PlaybackSessionRecord =>
  ({ id, item: ITEM }) as unknown as PlaybackSessionRecord;

/** Subtitles by hash: hash `a` matches A_FILE, `b` matches B_FILE; SHARED_FILE always. */
function rig() {
  const known = new Set<string>();
  const calls = { list: [] as (SubtitleHints | undefined)[], file: [] as string[] };
  let gate: Promise<void> | undefined;
  const subtitles = {
    list: async (_type: string, _videoId: string, hints?: SubtitleHints): Promise<SubtitleList> => {
      calls.list.push(hints);
      await gate;
      const ids = [SHARED_FILE];
      if (hints?.videoHash === 'a') ids.push(A_FILE);
      if (hints?.videoHash === 'b') ids.push(B_FILE);
      for (const id of ids) known.add(id);
      return {
        subtitles: ids.map((id) => ({ id, lang: 'eng', addonId: 'subs', url: `/x/${id}.vtt` })),
        addons: [],
      };
    },
    file: (fileId: string, offsetMs = 0): Promise<string> => {
      calls.file.push(fileId);
      if (!known.has(fileId)) {
        return Promise.reject(new SubtitleFileError('not-found', 'list them again'));
      }
      return Promise.resolve(`WEBVTT ${fileId} ${String(offsetMs)}`);
    },
  };
  const offsets = new Map<string, Map<string, number>>();
  let offsetReads = 0;
  const repo = {
    listSubtitleOffsets: (sessionId: string) => {
      offsetReads++;
      return Promise.resolve(new Map(offsets.get(sessionId)));
    },
    setSubtitleOffset: (sessionId: string, fileId: string, offsetMs: number) => {
      const bySession = offsets.get(sessionId) ?? new Map<string, number>();
      if (offsetMs === 0) bySession.delete(fileId);
      else bySession.set(fileId, offsetMs);
      offsets.set(sessionId, bySession);
      return Promise.resolve();
    },
  };
  const hintsBySession: Record<string, SubtitleHints> = {
    sa: { videoHash: 'a' },
    sb: { videoHash: 'b' },
  };
  const service = new SessionSubtitles({
    subtitles,
    repo,
    clock: manualClock(),
    hints: (record) => Promise.resolve(hintsBySession[record.id] ?? {}),
  });
  return {
    service,
    calls,
    known,
    reads: () => offsetReads,
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('SessionSubtitles', () => {
  it("keeps every session's files when two sessions of one item list it", async () => {
    const { service } = rig();
    await service.list(ITEM, { videoHash: 'a' }, 'sa');
    await service.list(ITEM, { videoHash: 'b' }, 'sb');
    expect(await service.has(session('sa'), A_FILE)).toBe(true);
    expect(await service.has(session('sb'), B_FILE)).toBe(true);
    expect(await service.file(session('sa'), A_FILE)).toBe(`WEBVTT ${A_FILE} 0`);
  });

  it("lists again with the session's hints when nothing is remembered", async () => {
    const { service, calls } = rig();
    // A restart: nothing listed yet, and the hash-matched file is asked first.
    expect(await service.file(session('sa'), A_FILE)).toBe(`WEBVTT ${A_FILE} 0`);
    expect(calls.list).toEqual([{ videoHash: 'a' }]);
    // Another session of the item, whose own files weren't part of that listing.
    expect(await service.has(session('sb'), B_FILE)).toBe(true);
    expect(calls.list).toEqual([{ videoHash: 'a' }, { videoHash: 'b' }]);
    // Once a session's listing is remembered, an unknown id lists nothing more.
    expect(await service.has(session('sb'), 'C'.repeat(32))).toBe(false);
    expect(calls.list).toHaveLength(2);
  });

  it('lists again once when the subtitle service forgot a listed file', async () => {
    const { service, calls, known } = rig();
    await service.list(ITEM, { videoHash: 'a' }, 'sa');
    known.clear(); // The service's URL cache entry was evicted.
    expect(await service.file(session('sa'), A_FILE)).toBe(`WEBVTT ${A_FILE} 0`);
    expect(calls.list).toHaveLength(2);
    expect(calls.file).toEqual([A_FILE, A_FILE]);
  });

  it('is not-found when the file is gone from the fresh listing too', async () => {
    const { service, calls, known } = rig();
    await service.list(ITEM, { videoHash: 'b' }, 'sa'); // B_FILE, listed under other hints
    known.clear();
    await expect(service.file(session('sa'), B_FILE)).rejects.toMatchObject({ code: 'not-found' });
    expect(calls.list).toHaveLength(2);
    // Forgotten for the item: not listed a third time.
    expect(await service.has(session('sa'), B_FILE)).toBe(false);
    expect(calls.list).toHaveLength(2);
  });

  it('shares one listing between concurrent misses of a session', async () => {
    const { service, calls, hold } = rig();
    const release = hold();
    const requests = [1, 2, 3].map(() => service.file(session('sa'), A_FILE));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The listing is under way and waiting on the addons; a fourth miss joins it.
    expect(calls.list).toHaveLength(1);
    requests.push(service.file(session('sa'), A_FILE));
    release();
    expect(await Promise.all(requests)).toEqual(Array(4).fill(`WEBVTT ${A_FILE} 0`));
    expect(calls.list).toHaveLength(1);
  });

  it('reads offsets from memory and follows every write', async () => {
    const { service, reads } = rig();
    await service.list(ITEM, { videoHash: 'a' }, 'sa');
    expect(await service.file(session('sa'), A_FILE)).toBe(`WEBVTT ${A_FILE} 0`);
    const before = reads();
    await service.file(session('sa'), A_FILE);
    await service.file(session('sa'), A_FILE, 100);
    expect(reads()).toBe(before);
    expect(await service.setOffset('sa', A_FILE, 2_500)).toBe(2_500);
    expect(await service.file(session('sa'), A_FILE, 100)).toBe(`WEBVTT ${A_FILE} 2600`);
    expect((await service.list(ITEM, { videoHash: 'a' }, 'sa')).subtitles).toContainEqual(
      expect.objectContaining({ id: A_FILE, offsetMs: 2_500 }),
    );
    await service.setOffset('sa', A_FILE, 0);
    expect(await service.file(session('sa'), A_FILE)).toBe(`WEBVTT ${A_FILE} 0`);
  });
});
