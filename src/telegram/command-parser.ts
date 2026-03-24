import { z } from "zod";

const UrlSchema = z.url();
const DEFAULT_RUNS_LIMIT = 5;
const MAX_RUNS_LIMIT = 20;
const DEFAULT_EXTRACT_MAX_PAGES = 1;
const MAX_EXTRACT_MAX_PAGES = 30;
const DEFAULT_CLEAR_CHAT_LIMIT = 20;
const MAX_CLEAR_CHAT_LIMIT = 100;
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;

export type TelegramCommand =
  | { kind: "help" }
  | { kind: "runs"; limit: number }
  | { kind: "extract"; url: string; maxPages: number }
  | { kind: "full"; url: string }
  | { kind: "force"; url: string }
  | { kind: "lightpanda"; url: string }
  | { kind: "mark"; url: string }
  | { kind: "defuddle"; url: string }
  | { kind: "subtitle"; url: string }
  | { kind: "subtitleTimestamp"; action: "on" | "off" | "status" }
  | { kind: "browserMode"; action: "on" | "off" | "status" }
  | { kind: "ytDlp"; action: "version" | "update" | "status" }
  | { kind: "cookieImport"; domain: string }
  | { kind: "cookieSet"; domain: string; cookie: string }
  | { kind: "cancel" }
  | { kind: "restart" }
  | { kind: "stats" }
  | { kind: "clearCache" }
  | { kind: "clearChat"; limit: number }
  | { kind: "cleanOutput"; scope: "all" | "site"; site?: string }
  | { kind: "cleanDownloads"; scope: "all" | "site"; site?: string }
  | { kind: "unknown" };

function toBoundedPositiveInt(
  input: string | undefined,
  fallback: number,
  max: number,
): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number(input);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function isUrl(value: string): boolean {
  return UrlSchema.safeParse(value).success;
}

function isScribdUrl(value: string): boolean {
  if (!isUrl(value)) {
    return false;
  }

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "scribd.com" || hostname.endsWith(".scribd.com");
  } catch {
    return false;
  }
}

function trimTrailingPunctuation(rawUrl: string): string {
  let value = rawUrl.trim();
  const plainTrailing = new Set([",", ".", "!", "?", ";", ":"]);

  while (value.length > 0) {
    const last = value.at(-1) ?? "";

    if (plainTrailing.has(last)) {
      value = value.slice(0, -1);
      continue;
    }

    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const openCount = value.split(open).length - 1;
      const closeCount = value.split(last).length - 1;
      if (closeCount > openCount) {
        value = value.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return value;
}

function extractFirstUrlFromText(input: string): string | null {
  for (const match of input.matchAll(URL_IN_TEXT_PATTERN)) {
    const raw = match[0] ?? "";
    const cleaned = trimTrailingPunctuation(raw);
    if (cleaned && isUrl(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

function normalizeCommandText(input: string): string {
  const token = input.trim().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) {
    return input.trim();
  }

  const atIndex = token.indexOf("@");
  if (atIndex === -1) {
    return input.trim();
  }

  const normalizedToken = token.slice(0, atIndex);
  const rest = input.trim().slice(token.length).trim();
  return rest ? `${normalizedToken} ${rest}` : normalizedToken;
}

function resolveCommandUrl(trimmed: string, parts: string[]): string | null {
  const direct = parts[1]?.trim() ?? "";
  if (direct && isUrl(direct)) {
    return direct;
  }

  return extractFirstUrlFromText(trimmed);
}

export function parseTelegramCommand(text: string): TelegramCommand {
  const trimmed = normalizeCommandText(text);
  if (!trimmed) {
    return { kind: "help" };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase() ?? "";

  if (command === "/start" || command === "/help" || command === "/menu") {
    return { kind: "help" };
  }

  if (command === "/runs") {
    return {
      kind: "runs",
      limit: toBoundedPositiveInt(parts[1], DEFAULT_RUNS_LIMIT, MAX_RUNS_LIMIT),
    };
  }

  if (command === "/extract") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: toBoundedPositiveInt(
        parts[2],
        DEFAULT_EXTRACT_MAX_PAGES,
        MAX_EXTRACT_MAX_PAGES,
      ),
    };
  }

  if (command === "/archive") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: toBoundedPositiveInt(
        parts[2],
        DEFAULT_EXTRACT_MAX_PAGES,
        MAX_EXTRACT_MAX_PAGES,
      ),
    };
  }

  if (command === "/scribd") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isScribdUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: DEFAULT_EXTRACT_MAX_PAGES,
    };
  }

  if (command === "/full" || command === "/pdf" || command === "/docx") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "full",
      url,
    };
  }

  if (
    command === "/force" ||
    command === "/bloomberg" ||
    command === "/nytimes" ||
    command === "/wsj" ||
    command === "/medium"
  ) {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "force",
      url,
    };
  }

  if (command === "/lightpanda") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "lightpanda",
      url,
    };
  }

  if (
    command === "/subtitletimestamp" ||
    command === "/subtitlets" ||
    command === "/timestamp"
  ) {
    const action = (parts[1] ?? "status").toLowerCase();

    if (action === "on" || action === "off" || action === "status") {
      return {
        kind: "subtitleTimestamp",
        action,
      };
    }

    return { kind: "unknown" };
  }

  if (command === "/subtitle") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "subtitle",
      url,
    };
  }

  if (command === "/mark" || command === "/md") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "mark",
      url,
    };
  }

  if (command === "/defuddle" || command === "/df") {
    const url = resolveCommandUrl(trimmed, parts);

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "defuddle",
      url,
    };
  }

  if (command === "/browser") {
    const action = (parts[1] ?? "status").toLowerCase();

    if (action === "on" || action === "off" || action === "status") {
      return {
        kind: "browserMode",
        action,
      };
    }

    return { kind: "unknown" };
  }

  if (command === "/ytdlp") {
    const action = (parts[1] ?? "status").toLowerCase();

    if (action === "version" || action === "update" || action === "status") {
      return {
        kind: "ytDlp",
        action,
      };
    }

    return { kind: "unknown" };
  }

  if (command === "/cookieimport") {
    const domain = parts[1]?.trim();

    if (!domain) {
      return { kind: "unknown" };
    }

    return {
      kind: "cookieImport",
      domain,
    };
  }

  if (command === "/cookieset") {
    const domain = parts[1]?.trim();
    const cookie = parts.slice(2).join(" ").trim();

    if (!domain || !cookie) {
      return { kind: "unknown" };
    }

    return {
      kind: "cookieSet",
      domain,
      cookie,
    };
  }

  if (command === "/cancel" || command === "/stop") {
    return { kind: "cancel" };
  }

  if (command === "/restart") {
    return { kind: "restart" };
  }

  if (command === "/stats") {
    return { kind: "stats" };
  }

  if (command === "/clearcache") {
    return { kind: "clearCache" };
  }

  if (command === "/clearchat") {
    return {
      kind: "clearChat",
      limit: toBoundedPositiveInt(
        parts[1],
        DEFAULT_CLEAR_CHAT_LIMIT,
        MAX_CLEAR_CHAT_LIMIT,
      ),
    };
  }

  if (command === "/cleanoutput" || command === "/cleandownloads") {
    const scopeRaw = parts[1]?.trim().toLowerCase();

    if (!scopeRaw) {
      return { kind: "unknown" };
    }

    const isAll = scopeRaw === "all";
    const scope = isAll ? "all" : "site";
    const site = isAll ? undefined : scopeRaw;
    if (command === "/cleanoutput") {
      return { kind: "cleanOutput", scope, site };
    }
    return { kind: "cleanDownloads", scope, site };
  }

  if (trimmed.startsWith("/")) {
    return { kind: "unknown" };
  }

  const inferredUrl = extractFirstUrlFromText(trimmed);
  if (inferredUrl) {
    return {
      kind: "extract",
      url: inferredUrl,
      maxPages: 1,
    };
  }

  return { kind: "unknown" };
}
