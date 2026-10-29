import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@multitap/api', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@multitap/api');
  });
});
