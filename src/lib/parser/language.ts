/**
 * Language detection for drift (SPEC.md §5.9).
 *
 * Code blocks, inline code, URLs and paths are stripped first: they are
 * English-looking noise sitting inside otherwise non-English prose, and they
 * are what makes a naive detector call a French close-out "English".
 */

import { franc } from 'franc-min';

/** ISO 639-3 (what franc returns) -> ISO 639-1 (what projects are configured with). */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en',
  fra: 'fr',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  pol: 'pl',
  ron: 'ro',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  ces: 'cs',
  ell: 'el',
  rus: 'ru',
  ukr: 'uk',
  tur: 'tr',
  arb: 'ar',
  cmn: 'zh',
  jpn: 'ja',
  kor: 'ko',
  hin: 'hi',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ro: 'Romanian',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  el: 'Greek',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)[\w./-]*\/[\w./-]+/g, ' ') // paths
    .replace(/^>\s*\[action\]\s*$/gm, ' ')
    .replace(/[*_#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Below this many prose characters, detection is not worth trusting. */
const MIN_PROSE_CHARS = 120;

export type Detection = {
  language: string | null; // ISO 639-1, or null when undetermined
  confidence: number;
};

export function detectLanguage(body: string): Detection {
  const prose = stripNonProse(body);
  if (prose.length < MIN_PROSE_CHARS) return { language: null, confidence: 0 };

  const code3 = franc(prose, { minLength: MIN_PROSE_CHARS });
  if (code3 === 'und') return { language: null, confidence: 0 };

  const code1 = ISO3_TO_ISO1[code3];
  if (!code1) return { language: null, confidence: 0 };

  // franc gives no score, so confidence is proxied by how much prose it saw.
  const confidence = Math.min(1, prose.length / 600);
  return { language: code1, confidence: Number(confidence.toFixed(2)) };
}

const ENGLISH_REQUEST_RE =
  /(Working language:\s*\**\s*English|\bask me in English\b|\brespond in English\b|\bin English\b|\bEnglish only\b)/i;

export function isLanguageRequest(body: string, workingLanguage: string): boolean {
  if (workingLanguage === 'en') return ENGLISH_REQUEST_RE.test(body);
  const name = languageName(workingLanguage);
  const re = new RegExp(
    `(Working language:\\s*\\**\\s*${name}|\\bin ${name}\\b|\\b${name} only\\b)`,
    'i',
  );
  return re.test(body);
}
