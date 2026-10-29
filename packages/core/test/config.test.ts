import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_MS } from '../src/addons/circuit-breaker.ts';
import { MANIFEST_TIMEOUT_MS } from '../src/addons/collection.ts';
import { ConfigError, DEFAULT_BITRATE_BY_HEIGHT, loadConfig } from '../src/config.ts';
import { STREAM_STORE_TTL_MS } from '../src/selection/stream-store.ts';
import { SUBTITLE_FETCH_TIMEOUT_MS, SUBTITLE_MAX_BYTES } from '../src/subtitles/index.ts';

// Fake secrets only.
const SECRET = 'fake-media-token-secret-0123456789abcdef';
const OLD_SECRET = 'fake-old-media-token-secret-0123456789ab';

describe('loadConfig', () => {
  it('applies the defaults', () => {
    const cwd = resolve('/srv/core');
    expect(loadConfig({}, cwd)).toEqual({
      apiPort: 8080,
      apiBind: null,
      dataDir: resolve(cwd, 'data'),
      logLevel: 'info',
      logging: { dir: null, stdout: true, fileKeep: 7, fileMaxSizeBytes: 50 * 1024 * 1024 },
      nodeEnv: 'production',
      backup: { dir: resolve(cwd, 'data/backups'), intervalMs: 0, keep: 7 },
      media: {
        port: 8081,
        bind: null,
        tokenSecret: null,
        previousTokenSecret: null,
        tokenTtlMs: 8 * 3_600_000,
        tokenMaxTtlMs: 7 * 86_400_000,
        publicBase: null,
      },
      corsOrigins: [],
      tls: null,
      sessions: {
        maxBitrate: 20_000_000,
        bitrateByHeight: DEFAULT_BITRATE_BY_HEIGHT,
        retentionIdleMs: 3_600_000,
        releasedKeepMs: 86_400_000,
        sweepIntervalMs: 60_000,
      },
      selection: {
        defaultHighRes: 'off',
        defaultEngine: undefined,
        preferredLanguage: 'eng',
        streamStoreTtlMs: 6 * 3_600_000,
        autoMaxAttempts: 5,
        autoRetryAfterMs: 30_000,
        autoAttemptTimeoutMs: 45_000,
      },
      addons: {
        timeoutsMs: { catalog: 5000, meta: 5000, streams: 10000, subtitles: 5000 },
        manifestTimeoutMs: 10_000,
        manifestRefreshMs: 21_600_000,
        responseCacheEntries: 1000,
        circuitFailures: 5,
        circuitResetMs: 60_000,
        userAgent: expect.stringMatching(/^Multitap\/\S+ \(\+https:\/\/multitap\.dev\)$/) as string,
        defaultManifestUrls: [],
        privateAllow: [],
      },
      subtitles: { timeoutMs: 10_000, maxBytes: 5 * 1024 * 1024 },
      engines: {
        healthIntervalMs: 30_000,
        healthTimeoutMs: 5_000,
        healthMaxBackoffMs: 60_000,
        connectTimeoutMs: 3_000,
        sessionTtlMs: null,
        admission: 'warn',
        loadWindowMs: 60_000,
        timeoutsMs: { control: 10_000, prepare: 150_000, media: 200_000 },
      },
      events: { replaySize: 1000, heartbeatMs: 15_000 },
    });
  });

  it('keeps the phase 1 hard-coded limits as defaults', () => {
    const config = loadConfig({});
    expect(config.addons.manifestTimeoutMs).toBe(MANIFEST_TIMEOUT_MS);
    expect(config.addons.circuitFailures).toBe(DEFAULT_FAILURE_THRESHOLD);
    expect(config.addons.circuitResetMs).toBe(DEFAULT_RESET_MS);
    expect(config.selection.streamStoreTtlMs).toBe(STREAM_STORE_TTL_MS);
    expect(config.subtitles.timeoutMs).toBe(SUBTITLE_FETCH_TIMEOUT_MS);
    expect(config.subtitles.maxBytes).toBe(SUBTITLE_MAX_BYTES);
  });

  it('reads every setting', () => {
    const config = loadConfig(
      {
        MULTITAP_API_PORT: '9000',
        MULTITAP_API_BIND: '127.0.0.1',
        MULTITAP_MEDIA_BIND: '::',
        MULTITAP_DATA_DIR: '/data',
        MULTITAP_LOG_LEVEL: 'debug',
        NODE_ENV: 'development',
        MULTITAP_SELECTION_DEFAULT_HIGH_RES: 'prepareOnly',
        MULTITAP_SELECTION_DEFAULT_ENGINE: 'alex-pc',
        MULTITAP_SELECTION_PREFERRED_LANGUAGE: 'ita',
        MULTITAP_ADDON_TIMEOUT_CATALOG_MS: '2000',
        MULTITAP_ADDON_TIMEOUT_META_MS: '3000',
        MULTITAP_ADDON_TIMEOUT_STREAMS_MS: '15000',
        MULTITAP_ADDON_TIMEOUT_SUBTITLES_MS: '4000',
        MULTITAP_ADDON_MANIFEST_REFRESH_MS: '3600000',
        MULTITAP_ADDON_RESPONSE_CACHE_ENTRIES: '50',
        MULTITAP_ADDON_TIMEOUT_MANIFEST_MS: '20000',
        MULTITAP_ADDON_CIRCUIT_FAILURES: '3',
        MULTITAP_ADDON_CIRCUIT_RESET_MS: '30000',
        MULTITAP_STREAM_STORE_TTL_MS: '3600000',
        MULTITAP_SUBTITLE_TIMEOUT_MS: '2000',
        MULTITAP_SUBTITLE_MAX_BYTES: '1048576',
        MULTITAP_MEDIA_PORT: '9001',
        MULTITAP_MEDIA_TOKEN_SECRET: SECRET,
        MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS: OLD_SECRET,
        MULTITAP_MEDIA_TOKEN_TTL_MS: '3600000',
        MULTITAP_MEDIA_TOKEN_MAX_TTL_MS: '86400000',
        MULTITAP_MEDIA_PUBLIC_BASE: 'https://media.example.org/',
        MULTITAP_CORS_ORIGINS: 'https://app.example.org, http://localhost:5173',
        MULTITAP_TLS_CERT_FILE: 'tls/cert.pem',
        MULTITAP_TLS_KEY_FILE: '/etc/core/key.pem',
        MULTITAP_SESSION_MAX_BITRATE: '12.5M',
        MULTITAP_SESSION_BITRATE_BY_HEIGHT: '720=2.5M, 480=1M,1080=5M',
        MULTITAP_RETENTION_IDLE_MS: '7200000',
        MULTITAP_SESSION_RELEASED_KEEP_MS: '3600000',
        MULTITAP_RETENTION_SWEEP_MS: '5000',
        MULTITAP_AUTO_SELECT_MAX_ATTEMPTS: '3',
        MULTITAP_AUTO_SELECT_RETRY_AFTER_MS: '0',
        MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS: '30000',
        MULTITAP_ENGINE_HEALTH_INTERVAL_MS: '10000',
        MULTITAP_ENGINE_HEALTH_TIMEOUT_MS: '2000',
        MULTITAP_ENGINE_HEALTH_MAX_BACKOFF_MS: '120000',
        MULTITAP_ENGINE_CONNECT_TIMEOUT_MS: '1500',
        MULTITAP_ENGINE_SESSION_TTL_MS: '172800000',
        MULTITAP_ENGINE_ADMISSION: 'reject',
        MULTITAP_ENGINE_LOAD_WINDOW_MS: '30000',
        MULTITAP_ENGINE_TIMEOUT_CONTROL_MS: '3000',
        MULTITAP_ENGINE_TIMEOUT_PREPARE_MS: '60000',
        MULTITAP_ENGINE_TIMEOUT_MEDIA_MS: '240000',
        MULTITAP_EVENTS_REPLAY_SIZE: '10',
        MULTITAP_EVENTS_HEARTBEAT_MS: '5000',
      },
      resolve('/srv/core'),
    );
    expect(config).toMatchObject({
      apiPort: 9000,
      apiBind: '127.0.0.1',
      dataDir: resolve('/data'),
      logLevel: 'debug',
      nodeEnv: 'development',
      selection: {
        defaultHighRes: 'prepareOnly',
        defaultEngine: 'alex-pc',
        preferredLanguage: 'ita',
      },
      addons: {
        timeoutsMs: { catalog: 2000, meta: 3000, streams: 15000, subtitles: 4000 },
        manifestRefreshMs: 3_600_000,
        responseCacheEntries: 50,
        manifestTimeoutMs: 20_000,
        circuitFailures: 3,
        circuitResetMs: 30_000,
      },
      media: {
        port: 9001,
        bind: '::',
        tokenSecret: SECRET,
        previousTokenSecret: OLD_SECRET,
        tokenTtlMs: 3_600_000,
        tokenMaxTtlMs: 86_400_000,
        publicBase: 'https://media.example.org',
      },
      corsOrigins: ['https://app.example.org', 'http://localhost:5173'],
      tls: {
        certFile: resolve('/srv/core', 'tls/cert.pem'),
        keyFile: resolve('/etc/core/key.pem'),
      },
      sessions: {
        maxBitrate: 12_500_000,
        bitrateByHeight: [
          { height: 480, bitrate: 1_000_000 },
          { height: 720, bitrate: 2_500_000 },
          { height: 1080, bitrate: 5_000_000 },
        ],
        retentionIdleMs: 7_200_000,
        releasedKeepMs: 3_600_000,
        sweepIntervalMs: 5_000,
      },
      subtitles: { timeoutMs: 2_000, maxBytes: 1_048_576 },
      engines: {
        healthIntervalMs: 10_000,
        healthTimeoutMs: 2_000,
        healthMaxBackoffMs: 120_000,
        connectTimeoutMs: 1_500,
        sessionTtlMs: 172_800_000,
        admission: 'reject',
        loadWindowMs: 30_000,
        timeoutsMs: { control: 3_000, prepare: 60_000, media: 240_000 },
      },
      events: { replaySize: 10, heartbeatMs: 5_000 },
    });
    expect(config.selection).toMatchObject({
      streamStoreTtlMs: 3_600_000,
      autoMaxAttempts: 3,
      autoRetryAfterMs: 0,
      autoAttemptTimeoutMs: 30_000,
    });
  });

  it('MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS=0 turns the limit off; below 5 s is refused', () => {
    expect(
      loadConfig({ MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS: '0' }).selection.autoAttemptTimeoutMs,
    ).toBe(null);
    expect(() => loadConfig({ MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS: '4999' })).toThrow(
      /MULTITAP_AUTO_SELECT_ATTEMPT_TIMEOUT_MS/,
    );
  });

  it('MULTITAP_SESSION_BITRATE_BY_HEIGHT: off, sorting, and its checks', () => {
    expect(
      loadConfig({ MULTITAP_SESSION_BITRATE_BY_HEIGHT: 'off' }).sessions.bitrateByHeight,
    ).toEqual([]);
    expect(
      loadConfig({ MULTITAP_SESSION_BITRATE_BY_HEIGHT: '2160=40M,360=800k' }).sessions
        .bitrateByHeight,
    ).toEqual([
      { height: 360, bitrate: 800_000 },
      { height: 2160, bitrate: 40_000_000 },
    ]);
    for (const bad of [
      '720',
      '720=fast',
      '720=50k',
      '100=1M',
      '720=3M,720=4M',
      '720=3M,1080=2M',
      '720=3M,,1080=6M',
    ]) {
      expect(() => loadConfig({ MULTITAP_SESSION_BITRATE_BY_HEIGHT: bad }), bad).toThrow(
        /MULTITAP_SESSION_BITRATE_BY_HEIGHT/,
      );
    }
  });

  it.each([
    ['0.0.0.0'],
    ['127.0.0.1'],
    ['::'],
    ['::1'],
    ['192.168.1.10'],
    ['multitap.lan'],
    ['localhost'],
  ])('accepts MULTITAP_API_BIND and MULTITAP_MEDIA_BIND=%s', (value) => {
    const config = loadConfig({ MULTITAP_API_BIND: value, MULTITAP_MEDIA_BIND: value });
    expect(config.apiBind).toBe(value);
    expect(config.media.bind).toBe(value);
  });

  it('MULTITAP_ENGINE_SESSION_TTL_MS: the range #25 accepts, and never shorter than MULTITAP_RETENTION_IDLE_MS', () => {
    expect(() => loadConfig({ MULTITAP_ENGINE_SESSION_TTL_MS: '59999' })).toThrow(
      /MULTITAP_ENGINE_SESSION_TTL_MS/,
    );
    expect(() => loadConfig({ MULTITAP_ENGINE_SESSION_TTL_MS: String(31 * 86_400_000) })).toThrow(
      /MULTITAP_ENGINE_SESSION_TTL_MS/,
    );
    expect(() => loadConfig({ MULTITAP_ENGINE_SESSION_TTL_MS: '600000' })).toThrow(
      /MULTITAP_RETENTION_IDLE_MS/,
    );
    expect(
      loadConfig({ MULTITAP_ENGINE_SESSION_TTL_MS: '600000', MULTITAP_RETENTION_IDLE_MS: '600000' })
        .engines.sessionTtlMs,
    ).toBe(600_000);
  });

  it('treats empty variables as unset and ignores unknown ones', () => {
    const config = loadConfig({ MULTITAP_API_PORT: '', MULTITAP_LOG_LEVEL: '', PATH: '/usr/bin' });
    expect(config.apiPort).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  it('resolves a relative MULTITAP_DATA_DIR against cwd', () => {
    const cwd = resolve('/srv/core');
    expect(loadConfig({ MULTITAP_DATA_DIR: 'state/db' }, cwd).dataDir).toBe(
      resolve(cwd, 'state/db'),
    );
  });

  it('fails with one readable line per invalid variable', () => {
    let error: unknown;
    try {
      loadConfig({
        MULTITAP_API_PORT: 'eighty',
        MULTITAP_SELECTION_DEFAULT_HIGH_RES: 'always',
        MULTITAP_LOG_LEVEL: 'info',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toMatch(/^Invalid configuration:\n/);
    expect(message).toMatch(/ {2}MULTITAP_API_PORT: .* \(got "eighty"\)/);
    expect(message).toMatch(/ {2}MULTITAP_SELECTION_DEFAULT_HIGH_RES: .* \(got "always"\)/);
    expect(message).not.toContain('MULTITAP_LOG_LEVEL');
  });

  it.each([['0'], ['65536'], ['80.5']])('rejects MULTITAP_API_PORT=%s', (value) => {
    expect(() => loadConfig({ MULTITAP_API_PORT: value })).toThrow(ConfigError);
  });

  it.each([
    ['MULTITAP_SELECTION_DEFAULT_ENGINE', 'Home PC'],
    ['MULTITAP_SELECTION_PREFERRED_LANGUAGE', 'en'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });
  it.each([
    ['20M', 20_000_000],
    ['800k', 800_000],
    ['1.5m', 1_500_000],
    ['6000000', 6_000_000],
  ])('parses MULTITAP_SESSION_MAX_BITRATE=%s', (value, expected) => {
    expect(loadConfig({ MULTITAP_SESSION_MAX_BITRATE: value }).sessions.maxBitrate).toBe(expected);
  });

  it.each([
    ['MULTITAP_SESSION_MAX_BITRATE', '50k'],
    ['MULTITAP_SESSION_MAX_BITRATE', '300M'],
    ['MULTITAP_SESSION_MAX_BITRATE', 'fast'],
    ['MULTITAP_MEDIA_PORT', '0'],
    ['MULTITAP_MEDIA_PORT', '8080'],
    ['MULTITAP_MEDIA_TOKEN_SECRET', 'too-short'],
    ['MULTITAP_MEDIA_TOKEN_TTL_MS', '1000'],
    ['MULTITAP_MEDIA_PUBLIC_BASE', 'media.example.org'],
    ['MULTITAP_MEDIA_PUBLIC_BASE', 'https://media.example.org/?x=1'],
    ['MULTITAP_CORS_ORIGINS', 'https://app.example.org/'],
    ['MULTITAP_CORS_ORIGINS', 'https://app.example.org/path'],
    ['MULTITAP_CORS_ORIGINS', '*'],
    ['MULTITAP_CORS_ORIGINS', 'https://ok.example.org,ftp://files.example.org'],
    ['MULTITAP_ADDON_CIRCUIT_FAILURES', '0'],
    ['MULTITAP_SUBTITLE_MAX_BYTES', '10'],
    ['MULTITAP_AUTO_SELECT_MAX_ATTEMPTS', '0'],
    ['MULTITAP_EVENTS_REPLAY_SIZE', '-1'],
    ['MULTITAP_API_BIND', 'http://0.0.0.0'],
    ['MULTITAP_API_BIND', '127.0.0.1:8080'],
    ['MULTITAP_MEDIA_BIND', 'bad host'],
    ['MULTITAP_MEDIA_BIND', '-lan'],
    ['MULTITAP_ENGINE_ADMISSION', 'block'],
    ['MULTITAP_ENGINE_LOAD_WINDOW_MS', '1000'],
    ['MULTITAP_ENGINE_CONNECT_TIMEOUT_MS', '50'],
    ['MULTITAP_ENGINE_CONNECT_TIMEOUT_MS', '60001'],
    ['MULTITAP_ENGINE_CONNECT_TIMEOUT_MS', '2.5s'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });

  it('treats an empty MULTITAP_CORS_ORIGINS as no CORS', () => {
    expect(loadConfig({ MULTITAP_CORS_ORIGINS: '' }).corsOrigins).toEqual([]);
    expect(loadConfig({ MULTITAP_CORS_ORIGINS: ' , ' }).corsOrigins).toEqual([]);
  });

  it.each([['MULTITAP_TLS_CERT_FILE'], ['MULTITAP_TLS_KEY_FILE']])(
    'rejects %s without the other',
    (name) => {
      expect(() => loadConfig({ [name]: '/etc/core/x.pem' })).toThrow(
        /MULTITAP_TLS_CERT_FILE and MULTITAP_TLS_KEY_FILE must be set together/,
      );
    },
  );

  it('rejects a default token TTL above the maximum', () => {
    expect(() =>
      loadConfig({
        MULTITAP_MEDIA_TOKEN_TTL_MS: '86400000',
        MULTITAP_MEDIA_TOKEN_MAX_TTL_MS: '3600000',
      }),
    ).toThrow(/MULTITAP_MEDIA_TOKEN_TTL_MS/);
  });

  it('reads the token secret from MULTITAP_MEDIA_TOKEN_SECRET_FILE', () => {
    const read: string[] = [];
    const config = loadConfig(
      { MULTITAP_MEDIA_TOKEN_SECRET_FILE: 'secrets/media' },
      resolve('/srv/core'),
      (path) => {
        read.push(path);
        return SECRET;
      },
    );
    expect(config.media.tokenSecret).toBe(SECRET);
    expect(read).toEqual([resolve('/srv/core', 'secrets/media')]);
  });

  it('rejects a secret file that is short, unreadable, or set alongside the variable', () => {
    expect(() => loadConfig({ MULTITAP_MEDIA_TOKEN_SECRET_FILE: 'x' }, '/', () => 'short')).toThrow(
      /MULTITAP_MEDIA_TOKEN_SECRET_FILE/,
    );
    expect(() =>
      loadConfig({ MULTITAP_MEDIA_TOKEN_SECRET_FILE: 'x' }, '/', () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/Could not be read/);
    expect(() =>
      loadConfig(
        { MULTITAP_MEDIA_TOKEN_SECRET: SECRET, MULTITAP_MEDIA_TOKEN_SECRET_FILE: 'x' },
        '/',
        () => SECRET,
      ),
    ).toThrow(/not both/);
  });

  it('needs a current secret for a previous one', () => {
    expect(() => loadConfig({ MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS: OLD_SECRET })).toThrow(
      /MULTITAP_MEDIA_TOKEN_SECRET_PREVIOUS/,
    );
  });

  it('reads the log file settings', () => {
    const cwd = resolve('/srv/core');
    expect(
      loadConfig(
        {
          MULTITAP_LOG_DIR: 'logs',
          MULTITAP_LOG_STDOUT: 'false',
          MULTITAP_LOG_FILE_KEEP: '3',
          MULTITAP_LOG_FILE_MAX_SIZE: '10M',
        },
        cwd,
      ).logging,
    ).toEqual({
      dir: resolve(cwd, 'logs'),
      stdout: false,
      fileKeep: 3,
      fileMaxSizeBytes: 10 * 1024 * 1024,
    });
    expect(
      loadConfig({ MULTITAP_LOG_DIR: '/var/log/core', MULTITAP_LOG_FILE_MAX_SIZE: '512M' }).logging,
    ).toMatchObject({ stdout: true, fileMaxSizeBytes: 512 * 1024 * 1024 });
  });

  it('rejects bad log file settings, and logging nowhere', () => {
    expect(() => loadConfig({ MULTITAP_LOG_STDOUT: 'false' })).toThrow(/MULTITAP_LOG_STDOUT/);
    expect(() => loadConfig({ MULTITAP_LOG_STDOUT: 'maybe' })).toThrow(/MULTITAP_LOG_STDOUT/);
    expect(() => loadConfig({ MULTITAP_LOG_FILE_KEEP: '0' })).toThrow(/MULTITAP_LOG_FILE_KEEP/);
    expect(() => loadConfig({ MULTITAP_LOG_FILE_MAX_SIZE: '10 megs' })).toThrow(
      /MULTITAP_LOG_FILE_MAX_SIZE/,
    );
    expect(() => loadConfig({ MULTITAP_LOG_FILE_MAX_SIZE: '100k' })).toThrow(
      /MULTITAP_LOG_FILE_MAX_SIZE/,
    );
  });

  it('reads the backup settings', () => {
    const cwd = resolve('/srv/core');
    expect(
      loadConfig(
        {
          MULTITAP_BACKUP_DIR: '/mnt/backups',
          MULTITAP_BACKUP_INTERVAL_MS: '86400000',
          MULTITAP_BACKUP_KEEP: '14',
        },
        cwd,
      ).backup,
    ).toEqual({ dir: resolve('/mnt/backups'), intervalMs: 86_400_000, keep: 14 });
    expect(loadConfig({ MULTITAP_DATA_DIR: 'state' }, cwd).backup.dir).toBe(
      resolve(cwd, 'state/backups'),
    );
  });

  it('rejects bad backup settings', () => {
    expect(() => loadConfig({ MULTITAP_BACKUP_INTERVAL_MS: '1000' })).toThrow(
      /MULTITAP_BACKUP_INTERVAL_MS/,
    );
    expect(() => loadConfig({ MULTITAP_BACKUP_INTERVAL_MS: '-5' })).toThrow(
      /MULTITAP_BACKUP_INTERVAL_MS/,
    );
    expect(() => loadConfig({ MULTITAP_BACKUP_KEEP: '0' })).toThrow(/MULTITAP_BACKUP_KEEP/);
  });

  it('never echoes a secret in an error', () => {
    let message = '';
    try {
      loadConfig({ MULTITAP_MEDIA_TOKEN_SECRET: 'short-fake-secret' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('MULTITAP_MEDIA_TOKEN_SECRET');
    expect(message).not.toContain('short-fake-secret');
  });
});
