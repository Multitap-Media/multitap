/**
 * `selection/language`: preferred audio languages (okf:concept/source-ranking rule 6).
 *
 * The preference is per request. {@link resolvePreferredLanguages} makes the
 * resolution order explicit: the request's list, else the profile's
 * (`audioLanguage`, `secondaryAudioLanguage`, when the request names a
 * profile), else the instance default
 * `MULTITAP_SELECTION_PREFERRED_LANGUAGE`. Codes compare as ISO 639-2/B, the form
 * release parsing produces (`parse/languages.ts`).
 */
import type { MediaTrack } from '@multitap/api';
import { normalizeLanguage } from './parse/languages.ts';

/** A language code as 639-2/B: `deu` → `ger`, `en` → `eng`; unknown codes are kept, lowercase. */
export function languageCode(code: string): string {
  return normalizeLanguage(code) ?? code.trim().toLowerCase();
}

export interface LanguagePreferenceSources {
  /** The request's own list (`preferredLanguage`), most preferred first. */
  request?: readonly string[] | undefined;
  /** The profile's list (its `audioLanguage` and `secondaryAudioLanguage`). */
  profile?: readonly string[] | undefined;
  /** The instance default (`MULTITAP_SELECTION_PREFERRED_LANGUAGE`). */
  instance: string;
}

/**
 * The effective preferred languages: the first non-empty of request, profile
 * and instance, as 639-2/B codes, deduplicated, most preferred first.
 */
export function resolvePreferredLanguages(sources: LanguagePreferenceSources): string[] {
  const chosen =
    sources.request !== undefined && sources.request.length > 0
      ? sources.request
      : sources.profile !== undefined && sources.profile.length > 0
        ? sources.profile
        : [sources.instance];
  const out: string[] = [];
  for (const code of chosen) {
    const normalized = languageCode(code);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * The audio track to start with (a session's `audioTrack`): the first of
 * `wanted` (codes, most wanted first) that some track has, preferring a
 * default-marked track of that language, then the first. Undefined with fewer
 * than two tracks (nothing to select: the audio is muxed) or no match.
 */
export function chooseAudioTrack(
  audio: readonly MediaTrack[],
  wanted: readonly string[],
): number | undefined {
  if (audio.length < 2) return undefined;
  for (const code of wanted) {
    const lang = languageCode(code);
    const matches = audio.filter((t) => t.lang !== undefined && languageCode(t.lang) === lang);
    const pick = matches.find((t) => t.default) ?? matches[0];
    if (pick !== undefined) return pick.index;
  }
  return undefined;
}
