/**
 * `selection/parse`: a stream → `SourceCandidate.parsed` (okf:architecture/normalized-addon-types, okf:concept/source-ranking).
 *
 * Names are read in priority order, and the first source that yields a field
 * wins: `behaviorHints.filename`, the release lines of the description, the
 * stream's label (`Torrentio\n4k DV | HDR10+`, `Easynews++\n1920 x 1080`),
 * then `bingeGroup`. Languages are the union of every source.
 */
import type { ParsedSource } from '@multitap/api';
import { extractInfo, releaseLines, type StreamText } from './extractors.ts';
import { mergeLanguages } from './languages.ts';
import { compact, parseReleaseName, type NameInfo } from './name.ts';

export type { StreamText } from './extractors.ts';
export { parseReleaseName, type NameInfo } from './name.ts';

/**
 * Bracketed tags like `[RD+]` carry nothing the name parser should see. The
 * class excludes `[` too, so a run of unclosed brackets is scanned once, not
 * once per bracket.
 */
function labelText(name: string | undefined): string | undefined {
  return name?.replace(/\[[^[\]]*\]/g, ' ').replace(/\n/g, ' ');
}

type Scalar = Exclude<keyof ParsedSource, 'languages'>;

export function parseStream(stream: StreamText): ParsedSource {
  const names = [
    stream.behaviorHints?.filename,
    ...releaseLines(stream.description ?? stream.title),
    labelText(stream.name),
    stream.behaviorHints?.bingeGroup?.replaceAll('|', ' '),
  ].filter((n): n is string => n !== undefined && n.trim() !== '');

  const parsedNames = names.map((n) => parseReleaseName(n));
  const infos: (NameInfo | ReturnType<typeof extractInfo>[number])[] = [
    ...extractInfo(stream),
    ...parsedNames,
  ];

  const out: Record<string, unknown> = {};
  for (const info of infos) {
    for (const [field, value] of Object.entries(info)) {
      if (field === 'languages' || value === undefined) continue;
      out[field as Scalar] ??= value;
    }
  }
  // Container only comes from a file name, never a label or a pack title.
  out.container = parsedNames.find((n) => n.container !== undefined)?.container;
  // A profile belongs to Dolby Vision; drop it if a better source said otherwise.
  if (out.hdr !== 'dv') delete out.dvProfile;

  const languages = mergeLanguages(...infos.map((info) => info.languages));
  if (languages.length > 0) out.languages = languages;
  return compact(out);
}
