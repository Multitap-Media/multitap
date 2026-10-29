import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamSchema, type Stream } from '@multitap/addon-protocol';

/** Real, redacted addon responses captured for packages/addon-protocol (read as data, not imported). */
export const REAL_STREAMS = join(
  import.meta.dirname,
  '../../../packages/addon-protocol/test/fixtures/real',
);

export type RealAddon = 'torrentio-public' | 'torrentio-rd' | 'easynews';

/** Every stream from every captured response of `addon`, validated, optionally one file only. */
export function realStreams(addon: RealAddon, file?: string): Stream[] {
  const dir = join(REAL_STREAMS, addon);
  return readdirSync(dir)
    .filter((f) => (file === undefined ? f.startsWith('stream-') : f === file))
    .sort()
    .flatMap((f) => {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { streams: unknown[] };
      return body.streams.map((s) => StreamSchema.parse(s));
    });
}

/** The value, or a test failure when it's missing. */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}`);
  return value;
}
