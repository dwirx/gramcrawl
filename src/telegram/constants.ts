export const SUBTITLE_SESSION_TTL_MS = 15 * 60 * 1_000;
export const SUBTITLE_MAX_ACTIVE_SESSIONS = 500;
export const EXTRACT_CACHE_DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;
export const EXTRACT_CACHE_DEFAULT_MAX_ENTRIES = 200;
export const BOT_RATE_LIMIT_DEFAULT_WINDOW_MS = 60 * 1_000;
export const BOT_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 8;
export const CHAT_QUEUE_MAX_LENGTH = 20;
export const CLEAN_CHAT_SCAN_MULTIPLIER = 4;
export const EXTRACT_DEFAULT_TIMEOUT_PER_PAGE_MS = 90_000;
export const EXTRACT_DEFAULT_TIMEOUT_BASE_MS = 30_000;
export const EXTRACT_DEFAULT_TIMEOUT_MAX_MS = 30 * 60 * 1_000;
export const BOT_RESTART_EXIT_DELAY_MS = 250;

export const LANGUAGE_COUNTRY_MAP: Record<string, string> = {
  ar: "SA",
  de: "DE",
  en: "US",
  es: "ES",
  fr: "FR",
  hi: "IN",
  hu: "HU",
  id: "ID",
  it: "IT",
  iw: "IL",
  ja: "JP",
  ko: "KR",
  ms: "MY",
  my: "MM",
  nl: "NL",
  pl: "PL",
  pt: "PT",
  ro: "RO",
  ru: "RU",
  th: "TH",
  tr: "TR",
  uk: "UA",
  vi: "VN",
  zh: "CN",
};
