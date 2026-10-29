/**
 * Language normalization. Everything becomes an ISO 639-2/B code (`eng`,
 * `ger`, `fre`), the form Easynews++ and most addons use, plus `mul` for
 * multi or dual audio releases.
 */

export const MULTI_LANGUAGE = 'mul';

/** ISO 639-1 → 639-2/B, for the codes release names and flags produce. */
const ISO1_TO_ISO2B: Record<string, string> = {
  ar: 'ara',
  bg: 'bul',
  bn: 'ben',
  ca: 'cat',
  cs: 'cze',
  da: 'dan',
  de: 'ger',
  el: 'gre',
  en: 'eng',
  es: 'spa',
  et: 'est',
  fa: 'per',
  fi: 'fin',
  fr: 'fre',
  he: 'heb',
  hi: 'hin',
  hr: 'hrv',
  hu: 'hun',
  id: 'ind',
  is: 'ice',
  it: 'ita',
  ja: 'jpn',
  kn: 'kan',
  ko: 'kor',
  lt: 'lit',
  lv: 'lav',
  ml: 'mal',
  mr: 'mar',
  ms: 'may',
  nl: 'dut',
  no: 'nor',
  pa: 'pan',
  pl: 'pol',
  pt: 'por',
  ro: 'rum',
  ru: 'rus',
  sk: 'slo',
  sl: 'slv',
  sr: 'srp',
  sv: 'swe',
  ta: 'tam',
  te: 'tel',
  th: 'tha',
  tl: 'fil',
  tr: 'tur',
  uk: 'ukr',
  ur: 'urd',
  vi: 'vie',
  zh: 'chi',
};

/** 639-2/T and other three-letter spellings that differ from /B. */
const ISO2T_TO_ISO2B: Record<string, string> = {
  deu: 'ger',
  fra: 'fre',
  nld: 'dut',
  ces: 'cze',
  zho: 'chi',
  ell: 'gre',
  fas: 'per',
  ron: 'rum',
  slk: 'slo',
  msa: 'may',
  isl: 'ice',
  spa: 'spa',
};

/** Country flag → the language it usually stands for in addon listings (Torrentio). */
const FLAG_COUNTRY_TO_ISO1: Record<string, string> = {
  GB: 'en',
  US: 'en',
  JP: 'ja',
  RU: 'ru',
  IT: 'it',
  PT: 'pt',
  BR: 'pt',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  KR: 'ko',
  CN: 'zh',
  TW: 'zh',
  HK: 'zh',
  FR: 'fr',
  DE: 'de',
  NL: 'nl',
  IN: 'hi',
  PL: 'pl',
  CZ: 'cs',
  HU: 'hu',
  BG: 'bg',
  RS: 'sr',
  HR: 'hr',
  UA: 'uk',
  DK: 'da',
  SE: 'sv',
  NO: 'no',
  FI: 'fi',
  TR: 'tr',
  SA: 'ar',
  AE: 'ar',
  EG: 'ar',
  IL: 'he',
  VN: 'vi',
  ID: 'id',
  MY: 'ms',
  TH: 'th',
  GR: 'el',
  RO: 'ro',
  LT: 'lt',
  LV: 'lv',
  EE: 'et',
  SK: 'sk',
  SI: 'sl',
  IR: 'fa',
  PH: 'tl',
  IS: 'is',
};

/**
 * One language token (`en`, `eng`, `deu`, `es-419`, `multi audio`) → 639-2/B,
 * `mul`, or `undefined` for anything that isn't an audio language.
 */
export function normalizeLanguage(token: string): string | undefined {
  const t = token.trim().toLowerCase();
  if (t === 'multi audio' || t === 'dual audio' || t === 'multi' || t === 'mul') {
    return MULTI_LANGUAGE;
  }
  const base = t.split(/[-_]/)[0] ?? t;
  if (base.length === 2) return ISO1_TO_ISO2B[base];
  if (base.length === 3) {
    if (ISO2T_TO_ISO2B[base] !== undefined) return ISO2T_TO_ISO2B[base];
    if (Object.values(ISO1_TO_ISO2B).includes(base)) return base;
  }
  return undefined;
}

const REGIONAL_INDICATOR_A = 0x1f1e6;
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** Languages for the country flag emoji in `text`, in order, deduplicated. */
export function languagesFromFlags(text: string): string[] {
  const out: string[] = [];
  for (const [flag] of text.matchAll(FLAG)) {
    // Two regional indicators, each a surrogate pair (two UTF-16 units).
    const letter = (at: number) =>
      String.fromCharCode(65 + (flag.codePointAt(at) ?? 0) - REGIONAL_INDICATOR_A);
    const country = letter(0) + letter(2);
    const iso1 = FLAG_COUNTRY_TO_ISO1[country];
    const lang = iso1 === undefined ? undefined : ISO1_TO_ISO2B[iso1];
    if (lang !== undefined && !out.includes(lang)) out.push(lang);
  }
  return out;
}

/** Order-preserving union. */
export function mergeLanguages(...lists: (readonly string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const lang of list ?? []) if (!out.includes(lang)) out.push(lang);
  }
  return out;
}
