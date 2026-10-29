/** Selection (okf:concept/source-ranking): parse streams, build candidates, rank them for an engine. */
export { parseReleaseName, parseStream, type NameInfo, type StreamText } from './parse/index.ts';
export {
  chooseAudioTrack,
  languageCode,
  resolvePreferredLanguages,
  type LanguagePreferenceSources,
} from './language.ts';
export {
  bingeGroupOf,
  candidateKey,
  toCandidate,
  toCandidates,
  type CandidateAddon,
  type CandidateOptions,
  type CandidateWithStream,
} from './candidates.ts';
export {
  annotate,
  playability,
  scoreCandidate,
  sizeRange,
  sortByRank,
  type RankEngine,
  type RankOptions,
} from './rank.ts';
export { compactTitle, mismatchOf, type MatchTarget, type Mismatch } from './match.ts';
export {
  ItemMetaLookup,
  itemInfo,
  parseRuntime,
  splitVideoId,
  type ItemInfo,
  type ItemMetaLookupOptions,
} from './item-meta.ts';
export {
  RANKING_SETTINGS_KEY,
  RankingSettingsError,
  RankingSettingsStore,
  diffSettings,
  type RankingSettingsStoreDeps,
} from './ranking-settings.ts';
export {
  STREAM_STORE_MAX_ENTRIES,
  STREAM_STORE_TTL_MS,
  StreamStore,
  type StoredStream,
  type StreamStoreOptions,
} from './stream-store.ts';
export {
  listSources,
  startSourceList,
  type SourcePartial,
  type StartedSourceList,
  type SourceListDeps,
  type SourceListRequest,
  type SourceListResult,
} from './source-list.ts';
