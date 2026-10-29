/**
 * Media tokens and the gateway (phase 2 step 5): both of Multitap's listeners over
 * real HTTP, the fake engine (in-process, or over HTTP for disconnects) and an
 * injected clock. Token forgery and expiry, revocation, the allowlist,
 * disconnects, two viewers, self-heal, session subtitles, `410` after release,
 * CORS, telemetry, metrics and log hygiene.
 */
import {
  MediaTokenSchema,
  SessionSubtitleListSchema,
  ViewerListSchema,
  type MediaToken,
  type SubtitleList,
} from '@multitap/api';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaApp } from '../src/gateway/app.ts';
import { createGatewayServices, type GatewayServices } from '../src/gateway/services.ts';
import { JoseTokenService } from '../src/gateway/tokens.ts';
import { openApiDocument } from '../src/http/app.ts';
import { listen, type Listener } from '../src/http/listen.ts';
import { shiftWebVtt, SubtitleFileError } from '../src/subtitles/index.ts';
import { bearer } from './helpers.ts';
import {
  httpStream,
  IH_DEAD,
  MOVIE,
  sessionRig,
  torrentStream,
  type RigOptions,
} from './session-setup.ts';

const SECRET = 'gateway-test-secret-0123456789abcdef';
const OTHER_SECRET = 'another-secret-not-core-s-0123456789';
const ORIGIN = 'https://party.example';
const PUBLIC_BASE = 'https://media.example.org';
const SUB_ID = 'A'.repeat(32);
const FOREIGN_SUB_ID = 'B'.repeat(32);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Subtitles per `type/videoId`, standing in for the addon layer. */
function fakeSubtitles() {
  const byItem: Record<string, string> = {
    [`movie/${MOVIE.id}`]: SUB_ID,
    'movie/tt0000002': FOREIGN_SUB_ID,
  };
  const calls = { list: 0, file: [] as string[], offsets: [] as number[] };
  return {
    calls,
    list: (type: string, videoId: string): Promise<SubtitleList> => {
      calls.list += 1;
      const id = byItem[`${type}/${videoId}`];
      return Promise.resolve({
        subtitles:
          id === undefined
            ? []
            : [{ id, lang: 'eng', addonId: 'subs', url: `/v1/subtitles/file/${id}.vtt` }],
        addons: [],
      });
    },
    file: (fileId: string, offsetMs = 0): Promise<string> => {
      calls.file.push(fileId);
      calls.offsets.push(offsetMs);
      if (![SUB_ID, FOREIGN_SUB_ID].includes(fileId)) {
        return Promise.reject(new SubtitleFileError('not-found', 'unknown'));
      }
      return Promise.resolve(
        shiftWebVtt(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${fileId}\n`, offsetMs),
      );
    },
  };
}

async function setup(options: RigOptions = {}) {
  const r = await sessionRig({
    ...options,
    env: {
      MULTITAP_MEDIA_TOKEN_SECRET: SECRET,
      MULTITAP_CORS_ORIGINS: ORIGIN,
      MULTITAP_MEDIA_PUBLIC_BASE: PUBLIC_BASE,
      ...options.env,
    },
  });
  const subtitles = fakeSubtitles();
  const gateway: GatewayServices = createGatewayServices({
    config: r.config,
    sessions: r.service,
    repo: r.repo,
    subtitles,
    clock: r.clock,
    logger: r.log.logger,
  });
  // Read lazily by the routes, so setting it after the app was built works.
  r.appDeps.gateway = gateway;
  const mediaApp = createMediaApp({
    config: r.config,
    logger: r.log.logger,
    services: { sessions: r.service, engines: r.module, gateway, metrics: r.metrics },
  });
  const api: Listener = await listen(r.app.fetch, 0, null);
  const media: Listener = await listen(mediaApp.fetch, 0, null);
  cleanups.push(async () => {
    r.service.stop();
    await Promise.all([api.close(), media.close()]);
    await r.settle();
    await r.fake.close();
    await r.db.destroy();
  });
  const key = await r.keyFor('client');
  const apiBase = `http://127.0.0.1:${String(api.port)}`;
  const mediaBase = `http://127.0.0.1:${String(media.port)}`;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(apiBase + path, {
      method,
      headers: {
        ...bearer(key),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as unknown };
  };

  /** A ready session on the fake engine; returns its id and engine session id. */
  const readySession = async (stream = httpStream('good')) => {
    const created = await call('POST', '/v1/sessions', {
      item: MOVIE,
      source: { key: r.list(stream) },
    });
    const id = (created.json() as { id: string }).id;
    await r.settle();
    const record = await r.repo.get(id);
    return { id, sid: record?.sid ?? '', status: record?.status };
  };

  const mint = async (id: string, subject: string, ttl?: number) => {
    const res = await call('POST', `/v1/sessions/${id}/tokens`, {
      subject,
      ...(ttl === undefined ? {} : { ttl }),
    });
    expect(res.status).toBe(201);
    return MediaTokenSchema.parse(res.json());
  };

  /** A media request; `file` is relative to the token's directory. */
  // GET and HEAD are idempotent. Under full-suite load, undici can pick a
  // pooled keep-alive socket the server has just closed and fail with
  // ECONNRESET before any byte is sent; a retry takes a fresh connection.
  const get = async (token: string, file: string, init: RequestInit = {}): Promise<Response> => {
    const url = `${mediaBase}/media/${token}/${file}`;
    try {
      return await fetch(url, init);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== 'ECONNRESET' || init.signal?.aborted) throw error;
      return fetch(url, init);
    }
  };

  return { r, gateway, subtitles, call, readySession, mint, get, mediaBase, apiBase };
}

const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('media tokens', () => {
  it('mints a token with mediaPath and an absolute mediaUrl, and serves master, playlist and segments', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id, sid } = await readySession();
    const token: MediaToken = await mint(id, 'member-1');
    expect(token.mediaPath).toBe(`/media/${token.token}/master.m3u8`);
    expect(token.mediaUrl).toBe(`${PUBLIC_BASE}${token.mediaPath}`);
    expect(Date.parse(token.exp)).toBe(r.clock() + 8 * 3_600_000);

    const master = await get(token.token, 'master.m3u8');
    expect(master.status).toBe(200);
    expect(master.headers.get('cache-control')).toBe('no-store');
    expect(master.headers.get('referrer-policy')).toBe('no-referrer');
    expect(master.headers.get('content-type')).toContain('mpegurl');
    expect(await master.text()).toContain('playlist.m3u8');

    const playlist = await get(token.token, 'playlist.m3u8');
    expect(await playlist.text()).toContain('seg0.ts');
    const segment = await get(token.token, 'seg2.ts');
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    expect(await bodyOf(segment)).toEqual(r.fake.segmentBody(sid, 'seg2.ts'));
  });

  it('caps a requested ttl at MULTITAP_MEDIA_TOKEN_MAX_TTL_MS', async () => {
    const { r, readySession, mint } = await setup({
      env: { MULTITAP_MEDIA_TOKEN_TTL_MS: '1800000', MULTITAP_MEDIA_TOKEN_MAX_TTL_MS: '3600000' },
    });
    const { id } = await readySession();
    const token = await mint(id, 'member-1', 86_400);
    expect(Date.parse(token.exp)).toBe(r.clock() + 3_600_000);
  });

  it('rejects forged, re-signed, unsigned and malformed tokens with 404', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id } = await readySession();
    const good = await mint(id, 'member-1');
    const exp = Math.floor(r.clock() / 1000) + 3_600;
    const claims = { sessionId: id, subject: 'member-1', epoch: 0 };
    const enc = (s: string) => new TextEncoder().encode(s);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

    const otherKey = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(exp)
      .sign(enc(OTHER_SECRET));
    // Right key, wrong algorithm: the algorithm is pinned to HS256.
    const hs512 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS512' })
      .setExpirationTime(exp)
      .sign(enc(SECRET.repeat(2)));
    const hs384SameKey = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS384' })
      .setExpirationTime(exp)
      .sign(enc(SECRET));
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, exp })}.x`;
    const [h, , s] = good.token.split('.');
    const tampered = `${h ?? ''}.${b64({ ...claims, subject: 'admin', exp })}.${s ?? ''}`;

    for (const token of [otherKey, hs512, hs384SameKey, none, tampered, 'a.b.c', 'not-a-token']) {
      const res = await get(token, 'master.m3u8');
      expect(res.status, token).toBe(404);
    }
    expect((await get(good.token, 'master.m3u8')).status).toBe(200);
  });

  it('answers 401 once a token has expired', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id } = await readySession();
    const token = await mint(id, 'member-1', 60);
    expect((await get(token.token, 'master.m3u8')).status).toBe(200);
    r.clock.advance(59_000);
    expect((await get(token.token, 'playlist.m3u8')).status).toBe(200);
    r.clock.advance(1_000);
    const expired = await get(token.token, 'playlist.m3u8');
    expect(expired.status).toBe(401);
    expect(expired.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('revokes one subject (404 for it only; 409 on re-mint) and all tokens (epoch bump)', async () => {
    const { readySession, mint, get, call } = await setup();
    const { id } = await readySession();
    const a = await mint(id, 'member-a');
    const b = await mint(id, 'member-b');

    expect((await call('DELETE', `/v1/sessions/${id}/tokens/member-a`)).status).toBe(204);
    expect((await get(a.token, 'master.m3u8')).status).toBe(404);
    expect((await get(b.token, 'master.m3u8')).status).toBe(200);
    expect((await call('POST', `/v1/sessions/${id}/tokens`, { subject: 'member-a' })).status).toBe(
      409,
    );

    const all = await call('POST', `/v1/sessions/${id}/tokens/revoke-all`);
    expect(all.status).toBe(200);
    expect(all.json()).toEqual({ tokenEpoch: 1 });
    expect((await get(b.token, 'master.m3u8')).status).toBe(404);
    const fresh = await mint(id, 'member-b');
    expect((await get(fresh.token, 'master.m3u8')).status).toBe(200);

    expect((await call('DELETE', '/v1/sessions/ps_unknown/tokens/x')).status).toBe(404);
    expect((await call('POST', '/v1/sessions/ps_unknown/tokens/revoke-all')).status).toBe(404);
    expect((await call('POST', '/v1/sessions/ps_unknown/tokens', { subject: 'x' })).status).toBe(
      404,
    );
  });

  it('forbids "revoke-all" as a subject', async () => {
    const { readySession, call } = await setup();
    const { id } = await readySession();
    const res = await call('POST', `/v1/sessions/${id}/tokens`, { subject: 'revoke-all' });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Record<string, unknown>;
    expect(problem.errors).toBeDefined();
  });

  it('keeps a subject revoked across a restart and accepts the previous secret while rotating', async () => {
    const { r, readySession } = await setup();
    const { id } = await readySession();
    const make = (secret: string, previous: string | null) =>
      new JoseTokenService({
        secret,
        previousSecret: previous,
        maxTtlMs: r.config.media.tokenMaxTtlMs,
        repo: r.repo,
        sessions: r.service,
        clock: r.clock,
        logger: r.log.logger,
      });
    const before = make(SECRET, null);
    const minted = await before.mint(id, 'member-a', 0, 3_600_000);
    await before.revokeSubject(id, 'member-a');

    // A new process: the revocation comes back from the database.
    const after = make(OTHER_SECRET, SECRET);
    expect(await after.verify(minted.token)).toEqual({ ok: false, reason: 'revoked' });
    const other = await before.mint(id, 'member-b', 0, 3_600_000);
    // Signed with the previous secret: still accepted.
    expect(await after.verify(other.token)).toMatchObject({ ok: true });
    // Without the previous secret, it's just a bad signature.
    expect(await make(OTHER_SECRET, null).verify(other.token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('signs with a random per-process key and warns when MULTITAP_MEDIA_TOKEN_SECRET is unset', async () => {
    const { r } = await setup();
    const service = new JoseTokenService({
      secret: null,
      previousSecret: null,
      maxTtlMs: 3_600_000,
      repo: r.repo,
      sessions: r.service,
      clock: r.clock,
      logger: r.log.logger,
    });
    expect(r.log.text()).toContain('MULTITAP_MEDIA_TOKEN_SECRET is not set');
    const minted = await service.mint('ps_x', 'member', 0, 60_000);
    expect(await service.verify(minted.token)).toEqual({ ok: false, reason: 'unknown-session' });
  });
});

describe('the media listener', () => {
  it('serves only allowlisted files under /media/{token}/ and never calls the engine otherwise', async () => {
    const { r, readySession, mint, get, mediaBase } = await setup();
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');
    const before = r.fake.requests.length;
    for (const file of [
      'stats.json',
      'probe',
      '../master.m3u8',
      '%2e%2e/master.m3u8',
      'master.m3u8x',
      'seg.ts',
      'segX.ts',
      'sub0.srt',
      'stream',
      'ext/sub/short.vtt',
      'ext/sub/../../x.vtt',
      'a/b/seg0.ts',
      `${sid}/seg0.ts`,
    ]) {
      expect((await get(token.token, file)).status, file).toBe(404);
    }
    for (const path of ['/healthz', '/v1/catalogs', '/hlsv2/probe', '/media', '/media/x']) {
      expect((await fetch(mediaBase + path)).status, path).toBe(404);
    }
    expect(r.fake.requests.length).toBe(before);
  });

  it('answers 404 while the session is not ready, and 410 once released', async () => {
    const { readySession, mint, get, call, r } = await setup();
    const failed = await readySession(torrentStream(IH_DEAD));
    expect(failed.status).toBe('failed');
    const failedToken = await mint(failed.id, 'member-1');
    expect((await get(failedToken.token, 'master.m3u8')).status).toBe(404);

    const { id } = await readySession();
    const token = await mint(id, 'member-1');
    expect((await get(token.token, 'master.m3u8')).status).toBe(200);
    expect((await call('DELETE', `/v1/sessions/${id}`)).status).toBe(204);
    expect((await get(token.token, 'master.m3u8')).status).toBe(410);
    expect((await get(token.token, 'seg0.ts')).status).toBe(410);
    expect((await call('POST', `/v1/sessions/${id}/tokens`, { subject: 'x' })).status).toBe(410);
    expect((await call('GET', `/v1/sessions/${id}/subtitles`)).status).toBe(410);
    expect(r.fake.sessions.size).toBe(0);
  });

  it('finishes a segment request on the engine when the viewer disconnects', async () => {
    const { r, readySession, mint, get } = await setup({
      realEngine: true,
      fake: { segmentLatencyMs: 300 },
    });
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');
    const viewer = new AbortController();
    const pending = get(token.token, 'seg5.ts', { signal: viewer.signal });
    await vi.waitFor(() => {
      expect(r.fake.fileRequestCount(sid, 'seg5.ts')).toBe(1);
    });
    viewer.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(r.fake.segmentsCompleted).toContain(`${sid}/seg5.ts`);
    });
    expect(r.fake.segmentsAborted).toEqual([]);
  });

  it('two tokens share one engine session: no new master creation, the engine dedupes segments', async () => {
    // The design (okf:architecture/engine-hls-model, okf:architecture/engine-session-lifecycle): both tokens map to the session's
    // one engine session id; each viewer request reaches the engine, whose
    // per-segment lock and disk cache make it one transcode.
    const { r, readySession, mint, get } = await setup();
    const { id, sid } = await readySession();
    const created = r.fake.masterRequests.filter((m) => m.created).length;
    const a = await mint(id, 'member-a');
    const b = await mint(id, 'member-b');
    const results = await Promise.all(
      [a, b].flatMap((t) => [get(t.token, 'master.m3u8'), get(t.token, 'seg1.ts')]),
    );
    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    const segA = results[1];
    const segB = results[3];
    if (segA === undefined || segB === undefined) throw new Error('missing response');
    expect(await bodyOf(segA)).toEqual(await bodyOf(segB));
    expect(r.fake.sessions.size).toBe(1);
    expect(new Set(r.fake.masterRequests.map((m) => m.sid))).toEqual(new Set([sid]));
    expect(r.fake.masterRequests.filter((m) => m.created).length).toBe(created);
    // One engine request per viewer request: nothing duplicated by the gateway.
    expect(r.fake.fileRequestCount(sid, 'seg1.ts')).toBe(2);
  });

  it('self-heals through the master after an eviction and after an engine restart', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');

    for (const lose of [
      () => {
        r.fake.evict(sid);
      },
      () => {
        r.fake.restart();
      },
    ]) {
      lose();
      expect((await get(token.token, 'playlist.m3u8')).status).toBe(404);
      expect((await get(token.token, 'master.m3u8')).status).toBe(200);
      const last = r.fake.mastersFor(sid).at(-1);
      expect(last?.created).toBe(true);
      expect(last?.mediaURL).toBe('https://media.example/good.mkv');
      expect((await get(token.token, 'playlist.m3u8')).status).toBe(200);
      expect((await get(token.token, 'seg0.ts')).status).toBe(200);
    }
  });

  it('retries an engine 404 on a segment once, only for a session that has served segments', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');

    // Nothing served yet: the 404 passes through untouched.
    r.fake.failSegmentOnce.add(`${sid}/seg0.ts`);
    expect((await get(token.token, 'seg0.ts')).status).toBe(404);
    expect(r.fake.fileRequestCount(sid, 'seg0.ts')).toBe(1);

    // Known good now: a source failing mid-stream gets one more try.
    expect((await get(token.token, 'seg0.ts')).status).toBe(200);
    r.fake.failSegmentOnce.add(`${sid}/seg1.ts`);
    const retried = await get(token.token, 'seg1.ts');
    expect(retried.status).toBe(200);
    expect(await bodyOf(retried)).toEqual(r.fake.segmentBody(sid, 'seg1.ts'));
    expect(r.fake.fileRequestCount(sid, 'seg1.ts')).toBe(2);
    expect(r.log.text()).toContain('retrying once');

    // Only once: a segment that is really gone still answers 404, after two engine requests.
    r.fake.evict(sid);
    expect((await get(token.token, 'seg2.ts')).status).toBe(404);
    expect(r.fake.fileRequestCount(sid, 'seg2.ts')).toBe(2);
    // Playlists are never retried.
    expect((await get(token.token, 'playlist.m3u8')).status).toBe(404);
    expect(r.fake.fileRequestCount(sid, 'playlist.m3u8')).toBe(1);
  });

  it('retries an engine 502 or 504 on a segment once, for any session', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');

    // Before any segment has been served: a 502 is still retried.
    r.fake.failSegmentOnceWith.set(`${sid}/seg0.ts`, 502);
    const first = await get(token.token, 'seg0.ts');
    expect(first.status).toBe(200);
    expect(await bodyOf(first)).toEqual(r.fake.segmentBody(sid, 'seg0.ts'));
    expect(r.fake.fileRequestCount(sid, 'seg0.ts')).toBe(2);

    r.fake.failSegmentOnceWith.set(`${sid}/seg1.ts`, 504);
    expect((await get(token.token, 'seg1.ts')).status).toBe(200);
    expect(r.fake.fileRequestCount(sid, 'seg1.ts')).toBe(2);
    expect(r.log.text()).toContain('retrying once');

    // Only once: the fake answers 404 then 502, and the retry's 502 passes
    // through with no engine text, after two engine requests.
    r.fake.failSegmentOnce.add(`${sid}/seg2.ts`);
    r.fake.failSegmentOnceWith.set(`${sid}/seg2.ts`, 502);
    const failed = await get(token.token, 'seg2.ts');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('hls:');
    expect(r.fake.fileRequestCount(sid, 'seg2.ts')).toBe(2);
  });

  it('marks a session as playing on segment requests only (engine load, okf:architecture/engine-session-lifecycle)', async () => {
    const { r, readySession, mint, get } = await setup();
    const { id } = await readySession();
    const token = await mint(id, 'member-1');
    await get(token.token, 'master.m3u8');
    await get(token.token, 'playlist.m3u8');
    expect(r.service.engineLoad('home')).toEqual({ resolving: 0, playing: 0 });
    await get(token.token, 'seg0.ts');
    expect(r.service.engineLoad('home')).toEqual({ resolving: 0, playing: 1 });
  });

  it("lists the session's subtitles and serves only its own item's files", async () => {
    const { readySession, mint, get, call, gateway, subtitles } = await setup();
    const { id } = await readySession();
    const listed = await call('GET', `/v1/sessions/${id}/subtitles`);
    expect(listed.status).toBe(200);
    const list = SessionSubtitleListSchema.parse(listed.json());
    expect(list.subtitles).toEqual([
      { id: SUB_ID, lang: 'eng', addonId: 'subs', path: `ext/sub/${SUB_ID}.vtt`, offsetMs: 0 },
    ]);
    const token = await mint(id, 'member-1');
    const vtt = await get(token.token, list.subtitles[0]?.path ?? '', {
      headers: { Origin: ORIGIN },
    });
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(vtt.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await vtt.text()).toContain(SUB_ID);

    // Another item's file, even one Multitap has listed, is not this session's.
    await gateway.subtitles.list({ type: 'movie', id: 'tt0000002' });
    expect((await get(token.token, `ext/sub/${FOREIGN_SUB_ID}.vtt`)).status).toBe(404);
    expect((await get(token.token, `ext/sub/${'C'.repeat(32)}.vtt`)).status).toBe(404);
    expect(subtitles.calls.file).toEqual([SUB_ID]);
  });

  it('applies a session offset to every viewer, plus a per-request offset, and persists it', async () => {
    const { readySession, mint, get, call, r } = await setup();
    const { id } = await readySession();
    const token = await mint(id, 'member-1');
    const other = await mint(id, 'member-2');
    const path = `/v1/sessions/${id}/subtitles/${SUB_ID}/offset`;
    const cue = async (t: string, query = '') =>
      (await (await get(t, `ext/sub/${SUB_ID}.vtt${query}`)).text()).split('\n')[2];

    expect(await cue(token.token)).toBe('00:00:01.000 --> 00:00:02.000');
    const put = await call('PUT', path, { offsetMs: 2500 });
    expect(put.status).toBe(200);
    expect(put.json()).toEqual({ offsetMs: 2500 });
    // Every viewer, with no action of their own.
    expect(await cue(other.token)).toBe('00:00:03.500 --> 00:00:04.500');
    expect(await cue(token.token)).toBe('00:00:03.500 --> 00:00:04.500');
    // The request's offset is added to the session's.
    expect(await cue(token.token, '?offsetMs=-1000')).toBe('00:00:02.500 --> 00:00:03.500');
    // The sum is clamped, not rejected.
    expect(await cue(token.token, '?offsetMs=999999999')).toBe('00:10:01.000 --> 00:10:02.000');
    // A cue pushed before 0 is dropped.
    expect(await cue(token.token, '?offsetMs=-5000')).toBeUndefined();
    // Not an integer: 400, no body.
    expect((await get(token.token, `ext/sub/${SUB_ID}.vtt?offsetMs=1.5`)).status).toBe(400);
    expect((await get(token.token, `ext/sub/${SUB_ID}.vtt?offsetMs=abc`)).status).toBe(400);

    const res = await get(token.token, `ext/sub/${SUB_ID}.vtt?offsetMs=10`, {
      headers: { Origin: ORIGIN },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    const listed = SessionSubtitleListSchema.parse(
      (await call('GET', `/v1/sessions/${id}/subtitles`)).json(),
    );
    expect(listed.subtitles[0]?.offsetMs).toBe(2500);
    // Stored in the database, so it outlives the process.
    expect((await r.repo.listSubtitleOffsets(id)).get(SUB_ID)).toBe(2500);

    expect((await call('PUT', path, { offsetMs: 0 })).status).toBe(200);
    expect(await cue(token.token)).toBe('00:00:01.000 --> 00:00:02.000');
    await call('PUT', path, { offsetMs: -300 });
    expect((await call('DELETE', path)).status).toBe(204);
    expect((await r.repo.listSubtitleOffsets(id)).size).toBe(0);
  });

  it('rejects subtitle offsets for unknown sessions and files, bad values and released sessions', async () => {
    const { readySession, call } = await setup();
    const { id } = await readySession();
    const path = (sid: string, file: string) => `/v1/sessions/${sid}/subtitles/${file}/offset`;
    expect((await call('PUT', path('ps_nope', SUB_ID), { offsetMs: 1 })).status).toBe(404);
    expect((await call('PUT', path(id, FOREIGN_SUB_ID), { offsetMs: 1 })).status).toBe(404);
    expect((await call('DELETE', path(id, FOREIGN_SUB_ID))).status).toBe(404);
    expect((await call('PUT', path(id, SUB_ID), { offsetMs: 600001 })).status).toBe(400);
    expect((await call('PUT', path(id, SUB_ID), { offsetMs: 1.5 })).status).toBe(400);
    expect((await call('PUT', path(id, 'short'), { offsetMs: 1 })).status).toBe(400);
    expect((await call('DELETE', `/v1/sessions/${id}`)).status).toBe(204);
    expect((await call('PUT', path(id, SUB_ID), { offsetMs: 1 })).status).toBe(410);
    expect((await call('DELETE', path(id, SUB_ID))).status).toBe(410);
  });

  it('lists subtitles again for a file request when nothing is remembered for the item', async () => {
    const { readySession, mint, get, subtitles } = await setup();
    const { id } = await readySession();
    const token = await mint(id, 'member-1');
    expect((await get(token.token, `ext/sub/${SUB_ID}.vtt`)).status).toBe(200);
    expect(subtitles.calls.list).toBe(1);
  });

  it('sends CORS headers to an allowed origin and none to others', async () => {
    const { readySession, mint, get } = await setup();
    const { id } = await readySession();
    const token = await mint(id, 'member-1');
    const allowed = await get(token.token, 'seg0.ts', { headers: { Origin: ORIGIN } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowed.headers.get('access-control-expose-headers')).toContain('Content-Length');
    expect(allowed.headers.get('vary')).toContain('Origin');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const other = await get(token.token, 'seg0.ts', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const expired = await get('x.y.z', 'seg0.ts', { headers: { Origin: ORIGIN } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('answers HEAD with headers only and ignores Range (whole file, 200)', async () => {
    const { r, readySession, mint, get } = await setup({ realEngine: true });
    const { id, sid } = await readySession();
    const token = await mint(id, 'member-1');
    const head = await get(token.token, 'seg0.ts', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1880');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const ranged = await get(token.token, 'seg0.ts', { headers: { Range: 'bytes=0-9' } });
    expect(ranged.status).toBe(200);
    expect(await bodyOf(ranged)).toEqual(r.fake.segmentBody(sid, 'seg0.ts'));
  });

  it('records per-subject telemetry, counts metrics, touches the session, and logs no token or path', async () => {
    const { r, readySession, mint, get, call } = await setup();
    const { id } = await readySession();
    const a = await mint(id, 'member-a');
    const b = await mint(id, 'member-b');
    for (const file of ['master.m3u8', 'playlist.m3u8', 'seg0.ts', 'seg1.ts']) {
      await (await get(a.token, file)).arrayBuffer();
    }
    await (await get(b.token, 'master.m3u8')).arrayBuffer();
    r.clock.advance(10_000);
    await (await get(b.token, 'seg7.ts')).arrayBuffer();

    const viewers = ViewerListSchema.parse(
      (await call('GET', `/v1/sessions/${id}/viewers`)).json(),
    );
    const bySubject = Object.fromEntries(viewers.viewers.map((v) => [v.subject, v]));
    expect(bySubject['member-a']).toMatchObject({
      lastFile: 'seg1.ts',
      lastSegment: 1,
      requests: 4,
    });
    expect(bySubject['member-a']?.bytes).toBeGreaterThan(2 * 1880);
    expect(bySubject['member-b']).toMatchObject({ lastSegment: 7, requests: 2 });
    expect((await r.repo.get(id))?.lastAccess).toBe(r.clock());

    const metrics = await r.metrics.metrics();
    expect(metrics).toMatch(/multitap_gateway_requests_total\{status="200"\} 6/);
    expect(metrics).toMatch(/multitap_gateway_bytes_total\{type="segment"\} \d+/);

    const logs = r.log.text();
    for (const t of [a, b]) expect(logs).not.toContain(t.token);
    expect(logs).not.toContain('/media/');
    const media = r.log.lines().filter((line) => line.msg === 'media');
    expect(media.length).toBe(6);
    expect(media[0]).toMatchObject({ sessionId: id, subject: 'member-a', status: 200 });

    expect((await call('DELETE', `/v1/sessions/${id}`)).status).toBe(204);
    expect((await call('GET', `/v1/sessions/${id}/viewers`)).status).toBe(410);
  });
});

describe('the OpenAPI document', () => {
  it('declares the token, viewer and subtitle routes with their errors', () => {
    const paths = openApiDocument().paths ?? {};
    expect(Object.keys(paths['/v1/sessions/{id}/tokens']?.post?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '403',
      '404',
      '409',
      '410',
    ]);
    expect(paths['/v1/sessions/{id}/tokens/{subject}']?.delete).toBeDefined();
    expect(paths['/v1/sessions/{id}/tokens/revoke-all']?.post).toBeDefined();
    expect(paths['/v1/sessions/{id}/viewers']?.get).toBeDefined();
    expect(paths['/v1/sessions/{id}/subtitles']?.get).toBeDefined();
    const offset = paths['/v1/sessions/{id}/subtitles/{fileId}/offset'];
    expect(Object.keys(offset?.put?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '403',
      '404',
      '410',
    ]);
    expect(offset?.delete).toBeDefined();
  });
});
