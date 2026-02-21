import { z } from "zod";

const UrlSchema = z.url();

export type TelegramCommand =
  | { kind: "help" }
  | { kind: "runs"; limit: number }
  | { kind: "extract"; url: string; maxPages: number }
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

export function parseTelegramCommand(text: string): TelegramCommand {
  const trimmed = text.trim();

  if (!trimmed || trimmed === "/start" || trimmed === "/help") {
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
