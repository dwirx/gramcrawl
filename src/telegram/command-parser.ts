import { z } from "zod";

const UrlSchema = z.url();
const DEFAULT_RUNS_LIMIT = 5;
const MAX_RUNS_LIMIT = 20;
const DEFAULT_EXTRACT_MAX_PAGES = 1;
const MAX_EXTRACT_MAX_PAGES = 30;

export type TelegramCommand =
  | { kind: "help" }
  | { kind: "runs"; limit: number }
  | { kind: "extract"; url: string; maxPages: number }
  | { kind: "mark"; url: string }
  | { kind: "subtitle"; url: string }
  | { kind: "subtitleTimestamp"; action: "on" | "off" | "status" }
  | { kind: "browserMode"; action: "on" | "off" | "status" }
  | { kind: "ytDlp"; action: "version" | "update" | "status" }
  | { kind: "cookieImport"; domain: string }
  | { kind: "cookieSet"; domain: string; cookie: string }
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
    const url = parts[1];

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
    const url = parts[1];

    if (!url || !isScribdUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: DEFAULT_EXTRACT_MAX_PAGES,
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
    const url = parts[1];

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "subtitle",
      url,
    };
  }

  if (command === "/mark" || command === "/md") {
    const url = parts[1];

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "mark",
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

  if (isUrl(trimmed)) {
    return {
      kind: "extract",
      url: trimmed,
      maxPages: 1,
    };
  }

  return { kind: "unknown" };
}
