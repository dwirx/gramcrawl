import type { TelegramApi } from "../api/client";

export function buildSendFileName(
  path: string,
  fallbackBaseName: string,
): string {
  const parts = path.split("/");
  const last = parts.at(-1);
  if (!last) {
    return `${fallbackBaseName}.txt`;
  }
  return last;
}

export async function sendSubtitleFiles(
  api: TelegramApi,
  chatId: number,
  files: Array<string | null>,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < files.length; index += 1) {
    const path = files[index];
    if (!path) {
      continue;
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
      failed += 1;
      continue;
    }

    try {
      await api.sendChatAction(chatId, "upload_document");
      await api.sendDocument(
        chatId,
        path,
        undefined,
        buildSendFileName(path, "subtitle"),
      );
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

export function isSubtitleTimestampEnabled(): boolean {
  return (process.env.EXTRACT_SUBTITLE_TIMESTAMP ?? "1").trim() === "1";
}

export function renderSubtitleLanguageList(
  languages: Array<{ code: string; hasManual: boolean; hasAuto: boolean }>,
): string {
  const manual = languages.filter((language) => language.hasManual);
  const autoOnly = languages.filter(
    (language) => !language.hasManual && language.hasAuto,
  );

  const sections: string[] = [];

  if (manual.length > 0) {
    sections.push("Prioritas 1 - Subtitle asli YouTube (manual):");
    sections.push(
      ...manual.map(
        (language, index) =>
          `${index + 1}. ${languageFlagIcon(language.code)} ${language.code}${language.hasAuto ? " (manual+auto)" : " (manual)"}`,
      ),
    );
    sections.push("");
  }

  if (autoOnly.length > 0) {
    sections.push("Prioritas 2 - Auto subtitle:");
    sections.push(
      ...autoOnly.map(
        (language, index) =>
          `${index + 1}. ${languageFlagIcon(language.code)} ${language.code} (auto)`,
      ),
    );
  }

  return sections.filter(Boolean).join("\n");
}

export function renderAllYoutubeLanguages(
  languages: Array<{ code: string; hasManual: boolean; hasAuto: boolean }>,
): string {
  if (languages.length === 0) {
    return "-";
  }

  const rendered = languages.map((language) => {
    const mode = language.hasManual ? "M" : language.hasAuto ? "A" : "?";
    return `${languageFlagIcon(language.code)} ${language.code}[${mode}]`;
  });

  const limited = rendered.slice(0, 12);
  const suffix =
    rendered.length > limited.length
      ? `, +${rendered.length - limited.length} lainnya`
      : "";
  return `${limited.join(", ")}${suffix}`;
}

export function languageFlagIcon(languageCode: string): string {
  const country = languageToCountryCode(languageCode);
  if (!country) {
    return "🌐";
  }
  return countryCodeToFlagEmoji(country);
}

function countryCodeToFlagEmoji(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return "🌐";
  }
  const codePoints = Array.from(countryCode).map(
    (char) => 127397 + char.charCodeAt(0),
  );
  return String.fromCodePoint(...codePoints);
}

function languageToCountryCode(languageCode: string): string | null {
  const normalized = languageCode.replaceAll("_", "-");
  const segments = normalized.split("-");
  const maybeRegion = segments.at(-1)?.toUpperCase();

  if (
    maybeRegion &&
    /^[A-Z]{2}$/.test(maybeRegion) &&
    maybeRegion !== segments[0]?.toUpperCase()
  ) {
    return maybeRegion;
  }

  const base = segments[0]?.toLowerCase();
  if (!base) {
    return null;
  }

  return LANGUAGE_COUNTRY_MAP[base] ?? null;
}

import { LANGUAGE_COUNTRY_MAP } from "../constants";

export function readEnvLines(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  return content.replaceAll(/\r\n/g, "\n").split("\n");
}

export function upsertEnvValue(
  lines: string[],
  key: string,
  value: string,
): string[] {
  const rendered = `${key}=${value}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      return line;
    }

    const currentKey = trimmed.slice(0, index).trim();
    if (currentKey !== key) {
      return line;
    }

    replaced = true;
    return rendered;
  });

  if (!replaced) {
    nextLines.push(rendered);
  }

  return nextLines;
}

export async function writeSubtitleTimestampToEnv(
  envPath: string,
  enabled: boolean,
): Promise<void> {
  const envFile = Bun.file(envPath);
  const content = (await envFile.exists()) ? await envFile.text() : "";
  const lines = readEnvLines(content);
  const nextLines = upsertEnvValue(
    lines,
    "EXTRACT_SUBTITLE_TIMESTAMP",
    enabled ? "1" : "0",
  );
  const nextContent = `${nextLines.join("\n").trimEnd()}\n`;

  await Bun.write(envPath, nextContent);
  process.env.EXTRACT_SUBTITLE_TIMESTAMP = enabled ? "1" : "0";
}

export async function writeBrowserFallbackToEnv(
  envPath: string,
  enabled: boolean,
): Promise<void> {
  const envFile = Bun.file(envPath);
  const content = (await envFile.exists()) ? await envFile.text() : "";
  const lines = readEnvLines(content);
  const nextLines = upsertEnvValue(
    lines,
    "EXTRACT_BROWSER_FALLBACK",
    enabled ? "1" : "0",
  );
  const nextContent = `${nextLines.join("\n").trimEnd()}\n`;

  await Bun.write(envPath, nextContent);
  process.env.EXTRACT_BROWSER_FALLBACK = enabled ? "1" : "0";
}

export function isBrowserFallbackEnabled(): boolean {
  return (process.env.EXTRACT_BROWSER_FALLBACK ?? "0").trim() === "1";
}
