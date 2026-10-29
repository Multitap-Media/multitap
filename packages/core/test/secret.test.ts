import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret, SECRET_REDACTED } from '../src/lib/secret.ts';
import { memoryLogger } from './helpers.ts';

// A fake value only.
const VALUE = 'FAKEsecretVALUE-0123456789';

describe('Secret (okf:architecture/secrets-classes-and-engine-password (a))', () => {
  it('shows only [redacted] when stringified, serialized or inspected', () => {
    const secret = new Secret(VALUE);
    expect(String(secret)).toBe(SECRET_REDACTED);
    expect([secret].join()).toBe(SECRET_REDACTED);
    expect(JSON.stringify({ nested: { secret } })).toBe('{"nested":{"secret":"[redacted]"}}');
    expect(inspect({ secret })).not.toContain(VALUE);
    expect(new Error(`failed with ${String(secret)}`).message).not.toContain(VALUE);
    expect(secret.reveal()).toBe(VALUE);
  });

  it('stays redacted in logs under any key, debug included', () => {
    for (const level of ['info', 'debug'] as const) {
      const { logger, text } = memoryLogger(level);
      logger[level]({ someField: new Secret(VALUE), deep: { a: [new Secret(VALUE)] } }, 'x');
      logger.flush();
      expect(text()).toContain('x');
      expect(text()).not.toContain(VALUE);
    }
  });
});
