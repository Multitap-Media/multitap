/**
 * Review PoC (destructive-item flags). `it.fails` asserts the CORRECT behaviour.
 */
import { DEFAULT_RANKING_SETTINGS } from '@multitap/api';
import { describe, expect, it } from 'vitest';
import { matchTitlePattern } from '../../../src/selection/safety.ts';

const SAFETY = DEFAULT_RANKING_SETTINGS.safety;

describe('safety title patterns: separators other than whitespace', () => {
  it.fails.each(['Delete.All.Files', 'Delete-All files', 'delete_all_torrents', 'Remove-All'])(
    '%j is flagged',
    (title) => {
      expect(matchTitlePattern(title, SAFETY)).toBeDefined();
    },
  );
});
