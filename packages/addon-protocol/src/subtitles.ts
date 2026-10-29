/** Subtitles. Ported from stremio-core's `types/resource/subtitles.rs`. */
import { z } from 'zod';
import { optional, urlString } from './common.ts';

export const SubtitlesSchema = z.looseObject({
  id: z.string(),
  /** Usually an ISO 639-2 code (`eng`), but addons send whatever they like. */
  lang: z.string(),
  url: urlString,
  label: optional(z.string()),
  fonts: z.array(urlString).default(() => []),
});
export type Subtitles = z.output<typeof SubtitlesSchema>;
