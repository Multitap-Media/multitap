import { SourceCandidateSchema } from '@multitap/api';
import { StreamSchema } from '@multitap/addon-protocol';
import { describe, expect, it } from 'vitest';
import { candidateKey, toCandidate, toCandidates } from '../src/selection/index.ts';
import { must, realStreams } from './selection-fixtures.ts';

const addon = { id: 'org.example.addon', name: 'Example' };
const HASH = '0123456789abcdef0123456789abcdef01234567';
const SECRET_URL = 'https://debrid.example/dl/SECRETTOKEN123/file.mkv';

const stream = (raw: Record<string, unknown>) => StreamSchema.parse(raw);

describe('toCandidate: kind and engine-independent playability', () => {
  it.each([
    [{ url: 'https://example.invalid/a.mkv' }, 'http', undefined],
    [{ ytId: 'dQw4w9WgXcQ' }, 'youtube', undefined],
    [{ infoHash: HASH, fileIdx: 1 }, 'torrent', undefined],
    [{ externalUrl: 'https://example.invalid/watch' }, 'external', 'external'],
    [{ playerFrameUrl: 'https://example.invalid/frame' }, 'external', 'unsupported'],
    [{ rarUrls: [['https://example.invalid/a.rar']] }, 'http', 'unsupported'],
    [{ zipUrls: [['https://example.invalid/a.zip', 10]] }, 'http', 'unsupported'],
    [{ '7zipUrls': [['https://example.invalid/a.7z']] }, 'http', 'unsupported'],
    [{ tgzUrls: [['https://example.invalid/a.tgz']] }, 'http', 'unsupported'],
    [{ tarUrls: [['https://example.invalid/a.tar']] }, 'http', 'unsupported'],
    [
      { nzbUrl: 'https://example.invalid/a.nzb', servers: ['nntps://news.example.invalid'] },
      'http',
      'unsupported',
    ],
  ])('%j → %s (%s)', (raw, kind, reason) => {
    const c = toCandidate(addon, stream(raw));
    expect(c).toBeDefined();
    expect(must(c).kind).toBe(kind);
    expect(must(c).unplayableReason).toBe(reason);
    expect(must(c).playable).toBe(reason === undefined);
    expect(SourceCandidateSchema.safeParse(c).success).toBe(true);
  });

  it('marks URL streams of live content types as live', () => {
    const s = stream({ url: 'https://example.invalid/live.m3u8' });
    expect(toCandidate(addon, s, { type: 'tv' })?.kind).toBe('live');
    expect(toCandidate(addon, s, { type: 'movie' })?.kind).toBe('http');
  });

  it('marks streams from an engine-local addon', () => {
    const c = toCandidate({ ...addon, engineId: 'alex-pc' }, stream({ url: 'https://x.invalid/' }));
    expect(c).toMatchObject({ kind: 'engine-local', requiresEngine: 'alex-pc' });
  });

  it('copies name, title and addon, and parses', () => {
    const c = toCandidate(
      addon,
      stream({
        name: '[RD+] Torrentio\n1080p',
        title: 'Movie.2020.1080p.BluRay.x264-G\n👤 50 💾 8 GB ⚙️ Site',
        url: 'https://example.invalid/1',
      }),
    );
    expect(c).toMatchObject({
      addonId: addon.id,
      addonName: 'Example',
      name: '[RD+] Torrentio\n1080p',
      title: 'Movie.2020.1080p.BluRay.x264-G\n👤 50 💾 8 GB ⚙️ Site',
      parsed: { height: 1080, codec: 'h264', cached: true, seeders: 50 },
    });
  });
});

describe('candidate keys', () => {
  it('are stable, and differ by addon and by source', () => {
    const s = stream({ url: SECRET_URL, name: 'a' });
    const key = must(toCandidate(addon, s)).key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(must(toCandidate(addon, stream({ url: SECRET_URL, name: 'renamed' }))).key).toBe(key);
    expect(must(toCandidate({ ...addon, id: 'other' }, s)).key).not.toBe(key);
    expect(must(toCandidate(addon, stream({ url: `${SECRET_URL}?2` }))).key).not.toBe(key);
  });

  it('separate torrent files by fileIdx', () => {
    const a = candidateKey('x', 'torrent', { infoHash: HASH, fileIdx: 0 });
    const b = candidateKey('x', 'torrent', { infoHash: HASH, fileIdx: 1 });
    expect(a).not.toBe(b);
  });

  it('include behaviorHints.proxyHeaders: same URL, other headers, other key', () => {
    const withHeaders = (request: Record<string, string>, response: Record<string, string> = {}) =>
      must(
        toCandidate(
          addon,
          stream({ url: SECRET_URL, behaviorHints: { proxyHeaders: { request, response } } }),
        ),
      ).key;
    const plain = must(toCandidate(addon, stream({ url: SECRET_URL }))).key;
    const a = withHeaders({ Referer: 'https://a.example/', 'User-Agent': 'X' });
    expect(a).not.toBe(plain);
    // Identical headers, in another order and case: the same key.
    expect(withHeaders({ 'user-agent': 'X', referer: 'https://a.example/' })).toBe(a);
    expect(withHeaders({ Referer: 'https://b.example/', 'User-Agent': 'X' })).not.toBe(a);
    expect(withHeaders({ Referer: 'https://a.example/', 'User-Agent': 'X' }, { A: 'b' })).not.toBe(
      a,
    );
    // Empty hints are no hints.
    expect(withHeaders({})).toBe(plain);
  });

  it('never embed the URL or its token', () => {
    const c = must(toCandidate(addon, stream({ url: SECRET_URL })));
    expect(JSON.stringify(c)).not.toContain('SECRETTOKEN123');
    expect(JSON.stringify(c)).not.toContain('debrid.example');
  });

  it('are unique across a real response, and keep addon order', () => {
    const streams = realStreams('torrentio-public', 'stream-movie-tt0110912.json');
    const out = toCandidates(addon, streams);
    expect(out).toHaveLength(streams.length);
    expect(new Set(out.map((o) => o.candidate.key)).size).toBe(streams.length);
    out.forEach((o, i) => {
      expect(o.stream).toBe(streams[i]);
    });
  });
});
