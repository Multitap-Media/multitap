/**
 * `selection/safety`: items and sources that look like actions rather than
 * media (okf:decision/destructive-items-flagged). Some addons list account actions as catalog
 * items, such as a debrid watchlist's "delete all files" entry, which plays
 * a request that empties the account. Multitap flags them `destructive` from the
 * `safety` ranking settings: plain phrases matched as whole words, and item id
 * prefixes. Flags never change a score; auto-select skips flagged sources.
 */
import type { ItemFlag, RankingSafety, SourceExplain } from '@multitap/api';

export type FlagReason = NonNullable<SourceExplain['flags']>[number];

/** Letters and digits: a phrase must not sit inside a longer word. */
const WORD = '[\\p{L}\\p{N}]';

const compiled = new WeakMap<readonly string[], (readonly [string, RegExp])[]>();

/** Each phrase with its regular expression, cached per settings array. */
function patternsOf(phrases: readonly string[]): (readonly [string, RegExp])[] {
  let out = compiled.get(phrases);
  if (out === undefined) {
    out = phrases
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => {
        const body = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return [p, new RegExp(`(?<!${WORD})${body}(?!${WORD})`, 'iu')] as const;
      });
    compiled.set(phrases, out);
  }
  return out;
}

/** The first title pattern found in `text`, if any. */
export function matchTitlePattern(
  text: string | undefined,
  safety: RankingSafety,
): string | undefined {
  if (text === undefined || text === '') return undefined;
  return patternsOf(safety.titlePatterns).find(([, re]) => re.test(text))?.[0];
}

/** True when `id` starts with one of the id prefixes. */
export function matchesIdPrefix(id: string | undefined, safety: RankingSafety): boolean {
  if (id === undefined) return false;
  return safety.idPrefixes.some((prefix) => prefix !== '' && id.startsWith(prefix));
}

/** Why an item (a catalog entry or meta: its id and name) is flagged; empty when it isn't. */
export function itemFlagReasons(
  item: { id?: string | undefined; name?: string | undefined },
  safety: RankingSafety,
): FlagReason[] {
  const out: FlagReason[] = [];
  const pattern = matchTitlePattern(item.name, safety);
  if (pattern !== undefined) {
    out.push({
      flag: 'destructive',
      rule: 'safety.titlePatterns',
      detail: `item name: '${pattern}'`,
    });
  }
  if (matchesIdPrefix(item.id, safety)) {
    out.push({ flag: 'destructive', rule: 'safety.idPrefixes', detail: 'item id' });
  }
  return out;
}

/** Why a source is flagged: its own name or description, plus its item's reasons. */
export function sourceFlagReasons(
  source: { name: string; title: string },
  itemReasons: readonly FlagReason[],
  safety: RankingSafety,
): FlagReason[] {
  const out: FlagReason[] = [];
  for (const [field, text] of [
    ['source name', source.name],
    ['source description', source.title],
  ] as const) {
    const pattern = matchTitlePattern(text, safety);
    if (pattern !== undefined) {
      out.push({
        flag: 'destructive',
        rule: 'safety.titlePatterns',
        detail: `${field}: '${pattern}'`,
      });
      break;
    }
  }
  return [...out, ...itemReasons];
}

/** The distinct flags behind some reasons, or undefined when there are none. */
export function flagsOf(reasons: readonly FlagReason[]): ItemFlag[] | undefined {
  if (reasons.length === 0) return undefined;
  return [...new Set(reasons.map((r) => r.flag))];
}

/** `flags` for an item view: present only when flagged. */
export function itemFlags(
  item: { id?: string | undefined; name?: string | undefined },
  safety: RankingSafety | undefined,
): { flags?: ItemFlag[] } {
  if (safety === undefined) return {};
  const flags = flagsOf(itemFlagReasons(item, safety));
  return flags === undefined ? {} : { flags };
}
