/**
 * `selection/match`: does a candidate look like what was asked for (see
 * okf:concept/source-ranking rule 7)? Mismatches are scored, never filtered: an addon may be wrong,
 * or a person may want it anyway.
 *
 * The evidence is the candidate's release lines (`releaseLines` of its
 * description: the file name first, then the pack name for Torrentio). For an
 * episode request:
 * - a line with both seasons and episodes decides: the requested one is in
 *   them (a match, or an episode-range pack containing it) or it isn't (another
 *   episode of the same show);
 * - a line with seasons only is a season or multi-season pack: fine when it
 *   contains the season, another episode when it doesn't;
 * - episode numbers without a season (anime absolute numbering, `E05`) and
 *   "complete" packs prove nothing either way.
 *
 * Titles are compared loosely: case, accents, punctuation, a leading article
 * and a trailing `(year)` are ignored, and the item's name only has to appear
 * somewhere in any line, so `The.Office.US`, `House of the Dragons` and a
 * pack named `Во все тяжкие / Breaking Bad` all match. A different title is
 * only claimed when no line names the item and, for an episode, the lines
 * don't state exactly the requested episode (an addon that found `S01E01`
 * by id under a translated name, like `Juego de Tronos`, is believed).
 */
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import type { SourceCandidate } from '@multitap/api';
import { releaseLines } from './parse/extractors.ts';

export interface MatchTarget {
  /** The item's name, from its meta. Empty: no title check. */
  name: string;
  /** Episode requests: both set. */
  season?: number | undefined;
  episode?: number | undefined;
  /** The item's (first) year, from its meta. */
  year?: number | undefined;
}

/** `episode`: same show, another episode. `title`: something else entirely (the worst). */
export type Mismatch = 'episode' | 'title';

/** Lowercase letters and digits only, accents stripped: `Spider-Man: No Way Home` → `spidermannowayhome`. */
export function compactTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The forms of the item's name to look for: compacted, without a leading article or trailing year. */
function nameForms(name: string): string[] {
  // No `\s*` before the year or the colon: on a long run of spaces it is quadratic.
  const trimmed = name
    .trim()
    .replace(/\((?:19|20)\d{2}\)$/, '')
    .trimEnd()
    .replace(/^(?:the|a|an)\s+/i, '');
  const forms = [compactTitle(trimmed)];
  // `Mission: Impossible – Dead Reckoning` is often released without its subtitle.
  const main = /^(.+?)[:–—]\s/.exec(trimmed)?.[1]?.trimEnd();
  if (main !== undefined && compactTitle(main).length >= 4) forms.push(compactTitle(main));
  return forms.filter((form) => form !== '');
}

function namesItem(lines: readonly string[], forms: readonly string[]): boolean {
  return lines.some((line) => {
    const text = compactTitle(line);
    return forms.some((form) => text.includes(form));
  });
}

/** A line states the item's year (±1, for release dates around New Year): likely a translated title. */
function statesYear(lines: readonly string[], year: number): boolean {
  return lines.some((line) =>
    [...line.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].some(
      (m) => Math.abs(Number(m[0]) - year) <= 1,
    ),
  );
}

type EpisodeVerdict = 'exact' | 'contains' | 'other' | 'unknown';

function safeParse(line: string): { seasons: number[]; episodes: number[] } {
  try {
    const r = parseTorrentTitle(line);
    return { seasons: r.seasons ?? [], episodes: r.episodes ?? [] };
  } catch {
    return { seasons: [], episodes: [] };
  }
}

/**
 * A file inside a pack can come with its folders (Show 001-206 [4x3]/Show - 001.mkv):
 * only the file's own name says which episode it is.
 */
function baseName(line: string): string {
  const slash = /\S\/(?=\S)/g;
  let last = -1;
  for (let m = slash.exec(line); m !== null; m = slash.exec(line)) last = m.index + 1;
  return last < 0 ? line : line.slice(last + 1);
}

function episodeVerdict(lines: readonly string[], season: number, episode: number): EpisodeVerdict {
  for (const line of lines) {
    const { seasons, episodes } = safeParse(baseName(line));
    if (seasons.length > 0 && episodes.length > 0) {
      if (!seasons.includes(season) || !episodes.includes(episode)) return 'other';
      return seasons.length === 1 && episodes.length === 1 ? 'exact' : 'contains';
    }
    if (seasons.length > 0) return seasons.includes(season) ? 'contains' : 'other';
    // Episodes without a season, or nothing: look at the next line (the pack).
  }
  return 'unknown';
}

/** How the candidate misses `target`, or undefined when it matches or nothing says otherwise. */
export function mismatchOf(
  candidate: Pick<SourceCandidate, 'title'>,
  target: MatchTarget,
): Mismatch | undefined {
  const lines = releaseLines(candidate.title);
  if (lines.length === 0) return undefined;
  const isEpisode = target.season !== undefined && target.episode !== undefined;
  const verdict = isEpisode
    ? episodeVerdict(lines, target.season ?? 0, target.episode ?? 0)
    : 'unknown';
  const forms = nameForms(target.name);
  if (
    forms.length > 0 &&
    verdict !== 'exact' &&
    !namesItem(lines, forms) &&
    !(target.year !== undefined && statesYear(lines, target.year))
  ) {
    return 'title';
  }
  return verdict === 'other' ? 'episode' : undefined;
}
