import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@multitap/addon-protocol', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@multitap/addon-protocol');
  });
});
