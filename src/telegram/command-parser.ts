import { z } from "zod";

const UrlSchema = z.url();

export type TelegramCommand =
  | { kind: "help" }
  | { kind: "runs"; limit: number }
  | { kind: "extract"; url: string; maxPages: number }
  | { kind: "mark"; url: string }
  | { kind: "subtitle"; url: string }
  | { kind: "subtitleTimestamp"; action: "on" | "off" | "status" }
  | { kind: "browserMode"; action: "on" | "off" | "status" }
  | { kind: "cookieImport"; domain: string }
  | { kind: "cookieSet"; domain: string; cookie: string }
  | { kind: "unknown" };

function toInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number(input);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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

  if (
    !trimmed ||
    trimmed === "/start" ||
    trimmed === "/help" ||
    trimmed === "/menu"
  ) {
    return { kind: "help" };
  }

  if (trimmed.startsWith("/runs")) {
    const parts = trimmed.split(/\s+/);
    return {
      kind: "runs",
      limit: toInt(parts[1], 5),
    };
  }

  if (trimmed.startsWith("/extract")) {
    const parts = trimmed.split(/\s+/);
    const url = parts[1];

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: toInt(parts[2], 1),
    };
  }

  if (trimmed.startsWith("/scribd")) {
    const parts = trimmed.split(/\s+/);
    const url = parts[1];

    if (!url || !isScribdUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "extract",
      url,
      maxPages: 1,
    };
  }

  if (
    trimmed.startsWith("/subtitletimestamp") ||
    trimmed.startsWith("/subtitlets") ||
    trimmed.startsWith("/timestamp")
  ) {
    const parts = trimmed.split(/\s+/);
    const action = (parts[1] ?? "status").toLowerCase();

    if (action === "on" || action === "off" || action === "status") {
      return {
        kind: "subtitleTimestamp",
        action,
      };
    }

    return { kind: "unknown" };
  }

  if (trimmed.startsWith("/subtitle")) {
    const parts = trimmed.split(/\s+/);
    const url = parts[1];

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "subtitle",
      url,
    };
  }

  if (trimmed.startsWith("/mark") || trimmed.startsWith("/md")) {
    const parts = trimmed.split(/\s+/);
    const url = parts[1];

    if (!url || !isUrl(url)) {
      return { kind: "unknown" };
    }

    return {
      kind: "mark",
      url,
    };
  }

  if (trimmed.startsWith("/browser")) {
    const parts = trimmed.split(/\s+/);
    const action = (parts[1] ?? "status").toLowerCase();

    if (action === "on" || action === "off" || action === "status") {
      return {
        kind: "browserMode",
        action,
      };
    }

    return { kind: "unknown" };
  }

  if (trimmed.startsWith("/cookieimport")) {
    const parts = trimmed.split(/\s+/);
    const domain = parts[1]?.trim();

    if (!domain) {
      return { kind: "unknown" };
    }

    return {
      kind: "cookieImport",
      domain,
    };
  }

  if (trimmed.startsWith("/cookieset")) {
    const parts = trimmed.split(/\s+/);
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
