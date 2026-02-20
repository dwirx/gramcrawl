import { z } from "zod";

const UrlSchema = z.url();

export type TelegramCommand =
  | { kind: "help" }
  | { kind: "runs"; limit: number }
  | { kind: "extract"; url: string; maxPages: number }
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

  if (isUrl(trimmed)) {
    return {
      kind: "extract",
      url: trimmed,
      maxPages: 1,
    };
  }

  return { kind: "unknown" };
}
