import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, UNREDACTED_WARNING, redactsAt } from '../src/log.ts';
import { memoryLogger } from './helpers.ts';

// Fake values only: nothing here is a real key or addon.
const FAKE_KEY = 'FAKEdebridKEY0123456789abcdef';
const FAKE_MANIFEST = `https://debrid-addon.example/${FAKE_KEY}/manifest.json`;
const FAKE_API_KEY = 'aGVsbG8taGVsbG8taGVsbG8taGVsbG8taGVsbG8taGVs';

describe('log redaction at info and above', () => {
  it('never writes a manifest URL or its key, at any depth', () => {
    const { logger, text, lines } = memoryLogger();
    logger.info({ manifestUrl: FAKE_MANIFEST }, 'top level');
    logger.info({ addon: { id: 'x', manifestUrl: FAKE_MANIFEST } }, 'nested');
    logger.info({ addon: { transportUrl: FAKE_MANIFEST } }, 'transport url');
    logger.info({ addons: [{ manifest_url: FAKE_MANIFEST }] }, 'db row in an array');
    logger.info({ a: { b: { c: { d: { manifestUrl: FAKE_MANIFEST } } } } }, 'deep');
    logger.flush();

    expect(text()).not.toContain(FAKE_KEY);
    expect(text()).not.toContain('debrid-addon.example');
    expect(lines()).toHaveLength(5);
    expect(lines()[1]).toMatchObject({ addon: { id: 'x', manifestUrl: REDACT_CENSOR } });
  });

  it('redacts stream URLs, media URLs, API keys and authorization headers', () => {
    const { logger, text, lines } = memoryLogger();
    logger.info({
      streams: [
        { name: 'a', url: `https://cdn.example/${FAKE_KEY}/video.mkv` },
        { name: 'b', externalUrl: `https://ext.example/${FAKE_KEY}` },
      ],
      session: { mediaURL: `http://engine.lan/${FAKE_KEY}/master.m3u8` },
      req: { headers: { authorization: `Bearer ${FAKE_API_KEY}` } },
      created: { apiKey: FAKE_API_KEY },
    });
    logger.flush();

    expect(text()).not.toContain(FAKE_KEY);
    expect(text()).not.toContain(FAKE_API_KEY);
    expect(lines()[0]).toMatchObject({
      streams: [
        { name: 'a', url: REDACT_CENSOR },
        { name: 'b', externalUrl: REDACT_CENSOR },
      ],
    });
  });

  it('redacts the secret database columns and raw streams', () => {
    const { logger, text, lines } = memoryLogger();
    const stream = { name: 'x', url: `https://cdn.example/${FAKE_KEY}/v.mkv` };
    logger.info(
      {
        row: { id: 'ps_1', status: 'ready', stream_json: JSON.stringify(stream) },
        engineSession: { sid: 'abc', media_url: `https://cdn.example/${FAKE_KEY}` },
        stored: { addonId: 'a', stream },
        rawStream: stream,
        req: { path: `/media/${FAKE_KEY}/master.m3u8` },
      },
      'session',
    );
    logger.flush();
    expect(text()).not.toContain(FAKE_KEY);
    expect(lines()[0]).toMatchObject({
      row: { id: 'ps_1', status: 'ready', stream_json: REDACT_CENSOR },
      engineSession: { sid: 'abc', media_url: REDACT_CENSOR },
      stored: { addonId: 'a', stream: REDACT_CENSOR },
    });
  });

  it.each(['info', 'warn', 'error', 'fatal'] as const)(
    'redacts at %s and writes no warning',
    (level) => {
      const { logger, text, lines } = memoryLogger(level);
      logger.fatal({ mediaURL: `https://cdn.example/${FAKE_KEY}` }, 'x');
      logger.flush();
      expect(text()).not.toContain(FAKE_KEY);
      expect(redactsAt(level)).toBe(true);
      expect(lines().some((l) => l.msg === UNREDACTED_WARNING)).toBe(false);
    },
  );

  it.each(['debug', 'trace'] as const)(
    'redacts nothing at %s, after a startup warning naming the level',
    (level) => {
      const { logger, text, lines } = memoryLogger(level);
      logger.debug(
        {
          manifestUrl: FAKE_MANIFEST,
          session: { mediaURL: `http://engine.lan/${FAKE_KEY}/master.m3u8` },
          req: { headers: { authorization: `Bearer ${FAKE_API_KEY}` } },
        },
        'unredacted',
      );
      logger.flush();
      expect(redactsAt(level)).toBe(false);
      expect(lines()[0]).toMatchObject({ level: 40, msg: UNREDACTED_WARNING });
      expect(lines()[0]?.logLevel).toBe(level);
      expect(text()).toContain(FAKE_MANIFEST);
      expect(text()).toContain(FAKE_API_KEY);
      expect(lines()[1]).toMatchObject({ manifestUrl: FAKE_MANIFEST });
    },
  );

  it('leaves ordinary fields alone', () => {
    const { logger, lines } = memoryLogger();
    logger.info({ route: '/v1/admin/api-keys', status: 200, addonId: 'org.example' }, 'request');
    logger.flush();
    expect(lines()[0]).toMatchObject({
      route: '/v1/admin/api-keys',
      status: 200,
      addonId: 'org.example',
      msg: 'request',
    });
  });
});
