import { z } from "zod";
import { runExtraction } from "../app/extract-service";
import { readManifest } from "../app/run-store";
import {
  extractCookieHeaderFromNetscape,
  extractCookieMapFromNetscape,
  hasCookieName,
  writeCookieToEnv,
} from "../cli/cookie-env";
import {
  downloadSubtitlesAndConvert,
  listAvailableSubtitles,
  pickPreferredSubtitleLanguages,
  resolveOriginalLanguage,
  type SubtitleLanguage,
} from "../subtitle/service";
import { parseTelegramCommand } from "./command-parser";
import { createLogger } from "./logger";

type TelegramApiResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
};

type TelegramMessage = {
  message_id: number;
};

type TelegramFile = {
  file_path?: string;
  file_size?: number;
};

type TelegramChatAction = "typing" | "upload_document";
type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};
type MainMenuAction = "extract" | "subtitle" | "runs" | "settings" | "help";
type TelegramBotCommand = {
  command: string;
  description: string;
};
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_MAX_RETRIES = 3;
const SUBTITLE_SESSION_TTL_MS = 15 * 60 * 1_000;

const BotConfigSchema = z.object({
  token: z.string().min(10),
  outputRoot: z.string().default("output"),
  envPath: z.string().default(".env"),
});

type BotConfig = z.infer<typeof BotConfigSchema>;
type PendingSubtitleSelection = {
  chatId: number;
  url: string;
  title: string;
  languages: Set<string>;
  createdAt: number;
};
const LANGUAGE_COUNTRY_MAP: Record<string, string> = {
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

class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async requestJson<T>(
    method: string,
    body: Record<string, unknown> | FormData,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= TELEGRAM_MAX_RETRIES; attempt += 1) {
      try {
        const isForm = body instanceof FormData;
        const response = await fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: isForm ? undefined : { "content-type": "application/json" },
          body: isForm ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
        });

        const payload = (await response.json()) as TelegramApiResponse<T>;

        if (payload.ok) {
          return payload.result;
        }

        const description = payload.description ?? `Telegram ${method} error`;
        const retryAfterMatch = description.match(/retry after (\d+)/i);
        const retryAfterSeconds = Number(retryAfterMatch?.[1] ?? "");
        const isRetryableDescription =
          description.includes("Too Many Requests") ||
          description.includes("Internal Server Error") ||
          description.includes("Bad Gateway");

        if (isRetryableDescription && attempt < TELEGRAM_MAX_RETRIES) {
          const delay = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1_000
            : attempt * 800;
          await Bun.sleep(delay);
          continue;
        }

        throw new Error(description);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < TELEGRAM_MAX_RETRIES) {
          await Bun.sleep(attempt * 600);
          continue;
        }
      }
    }

    throw new Error(lastError?.message ?? `Telegram ${method} failed`);
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    return this.requestJson<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: 30,
      limit: 20,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<number> {
    const result = await this.requestJson<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return result.message_id;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.requestJson<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  async sendDocument(
    chatId: number,
    path: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File tidak ditemukan: ${path}`);
    }

    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(
      "document",
      file,
      fileName ?? path.split("/").at(-1) ?? "document",
    );
    if (caption) {
      form.set("caption", caption);
    }

    await this.requestJson<unknown>("sendDocument", form);
  }

  async sendChatAction(
    chatId: number,
    action: TelegramChatAction,
  ): Promise<void> {
    await this.requestJson<unknown>("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async getFilePath(fileId: string): Promise<TelegramFile> {
    return this.requestJson<TelegramFile>("getFile", {
      file_id: fileId,
    });
  }

  async downloadFileText(filePath: string): Promise<string> {
    const url = `${this.baseUrl.replace("/bot", "/file/bot")}/${filePath}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Gagal download file Telegram: ${response.status}`);
    }

    return response.text();
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    await this.requestJson<unknown>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    await this.requestJson<unknown>("setMyCommands", {
      commands,
    });
  }
}

function buildHelpMessage(): string {
  return [
    "TeleExtract Bot - Bantuan",
    "",
    "Perintah utama:",
    "• /extract <url> [maxPages]",
    "  Ekstrak website ke JSON + Markdown + TXT.",
    "• /scribd <url-scribd>",
    "  Shortcut extract 1 halaman khusus Scribd.",
    "  Bot akan kirim TXT + DOCX + PDF jika konten terbaca.",
    "• /subtitle <url>",
    "  Ambil subtitle YouTube (pilih bahasa lewat tombol).",
    "• /runs [limit]",
    "  Lihat riwayat extract terbaru.",
    "",
    "Pengaturan:",
    "• /subtitletimestamp <on|off|status>",
    "• /timestamp <on|off|status> (alias cepat)",
    "• /browser <on|off|status>",
    "",
    "Cookie:",
    "• Upload cookies.txt tanpa command",
    "  Auto import semua domain dari file.",
    "• /cookieimport <domain> (pakai caption saat upload file)",
    "• /cookieset <domain> <cookie-header>",
    "",
    "Tips cepat:",
    "• Kirim URL langsung tanpa command untuk extract 1 halaman.",
    "• /menu atau /help untuk tampilkan bantuan ini.",
  ].join("\n");
}

function buildTelegramCommandSuggestions(): TelegramBotCommand[] {
  return [
    { command: "start", description: "Buka menu utama bot" },
    { command: "help", description: "Lihat bantuan lengkap" },
    {
      command: "extract",
      description: "Ekstrak halaman web: /extract <url> [maxPages]",
    },
    {
      command: "scribd",
      description: "Extract cepat Scribd: /scribd <url-scribd>",
    },
    {
      command: "subtitle",
      description: "Ambil subtitle YouTube: /subtitle <url>",
    },
    { command: "runs", description: "Lihat riwayat extract terbaru" },
    {
      command: "browser",
      description: "Status/ubah browser fallback: on|off|status",
    },
    {
      command: "subtitletimestamp",
      description: "Status/ubah timestamp subtitle: on|off|status",
    },
    {
      command: "cookieimport",
      description: "Import cookie dari cookies.txt per domain",
    },
    {
      command: "cookieset",
      description: "Set cookie header manual per domain",
    },
  ];
}

function buildWelcomeMenuMessage(): string {
  return [
    "TeleExtract Bot - Menu Utama",
    "",
    "Pilih aksi dari tombol di bawah:",
    "• Extract artikel website",
    "• Ambil subtitle YouTube",
    "• Lihat riwayat run",
    "• Cek status pengaturan",
    "",
    "Tips: Anda juga bisa kirim URL langsung untuk extract cepat.",
  ].join("\n");
}

function buildMainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Extract", callback_data: "menu:extract" },
        { text: "Subtitle", callback_data: "menu:subtitle" },
      ],
      [
        { text: "Runs", callback_data: "menu:runs" },
        { text: "Settings", callback_data: "menu:settings" },
      ],
      [{ text: "Help", callback_data: "menu:help" }],
    ],
  };
}

function modeLabel(enabled: boolean): string {
  return enabled ? "AKTIF" : "NONAKTIF";
}

function modeEnvValue(enabled: boolean): "1" | "0" {
  return enabled ? "1" : "0";
}

function buildUnknownCommandMessage(input: string): string {
  return [
    "Perintah tidak dikenali.",
    `Input: ${input}`,
    "",
    "Contoh yang benar:",
    "• /extract https://example.com/artikel 1",
    "• /scribd https://www.scribd.com/document/123456789/judul",
    "• /subtitle https://www.youtube.com/watch?v=xxxx",
    "• /runs 5",
    "",
    "Ketik /help atau /menu untuk daftar perintah lengkap.",
  ].join("\n");
}

function parseMainMenuCallbackData(
  value: string | undefined,
): MainMenuAction | null {
  if (!value || !value.startsWith("menu:")) {
    return null;
  }

  const action = value.slice("menu:".length);
  if (
    action === "extract" ||
    action === "subtitle" ||
    action === "runs" ||
    action === "settings" ||
    action === "help"
  ) {
    return action;
  }

  return null;
}

function buildMenuActionMessage(action: MainMenuAction): string {
  if (action === "extract") {
    return [
      "Panduan cepat Extract:",
      "• /extract <url> [maxPages]",
      "• Contoh: /extract https://example.com/artikel 1",
      "• /scribd <url-scribd> (khusus Scribd)",
      "",
      "Anda juga bisa kirim URL langsung tanpa command.",
    ].join("\n");
  }

  if (action === "subtitle") {
    return [
      "Panduan cepat Subtitle:",
      "• /subtitle <url-youtube>",
      "• Contoh: /subtitle https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "",
      "Bot akan menampilkan tombol pilihan bahasa subtitle.",
    ].join("\n");
  }

  return "";
}

function renderField(label: string, value: string | number): string {
  return `• ${label}: ${String(value)}`;
}

function buildStatusCard(
  title: string,
  fields: Array<{ label: string; value: string | number }>,
  note?: string,
): string {
  const lines = [
    title,
    ...fields.map((field) => renderField(field.label, field.value)),
  ];
  if (note) {
    lines.push("", note);
  }
  return lines.join("\n");
}

function subtitleButtonLabel(language: SubtitleLanguage): string {
  const icon = languageFlagIcon(language.code);
  if (language.hasManual && language.hasAuto) {
    return `${icon} ${language.code} [M+A]`;
  }
  if (language.hasManual) {
    return `${icon} ${language.code} [M]`;
  }
  if (language.hasAuto) {
    return `${icon} ${language.code} [A]`;
  }
  return `${icon} ${language.code}`;
}

function buildSubtitleKeyboard(
  sessionId: string,
  languages: SubtitleLanguage[],
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (const language of languages) {
    currentRow.push({
      text: subtitleButtonLabel(language),
      callback_data: `subtitle:${sessionId}:${encodeURIComponent(language.code)}`,
    });

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return { inline_keyboard: rows };
}

function createSubtitleSessionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupSubtitleSessions(
  sessions: Map<string, PendingSubtitleSelection>,
): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.createdAt > SUBTITLE_SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function parseSubtitleCallbackData(
  value: string | undefined,
): { sessionId: string; language: string } | null {
  if (!value || !value.startsWith("subtitle:")) {
    return null;
  }

  const [prefix, sessionId, encodedLanguage] = value.split(":");
  if (prefix !== "subtitle" || !sessionId || !encodedLanguage) {
    return null;
  }

  return {
    sessionId,
    language: decodeURIComponent(encodedLanguage),
  };
}

function buildRunsMessage(
  runs: Awaited<ReturnType<typeof readManifest>>,
  limit: number,
): string {
  const selectedRuns = runs.slice(0, limit);
  const lines = selectedRuns.map((run, index) =>
    [
      `${index + 1}. ${run.site}`,
      `Run ID: ${run.id}`,
      `Halaman dicrawl: ${run.crawledPages}`,
      `File markdown: ${run.articleFiles}`,
      `URL: ${run.rootUrl}`,
    ].join("\n"),
  );

  return lines.length > 0
    ? [
        `Riwayat extract (${selectedRuns.length}/${runs.length})`,
        "",
        lines.join("\n\n"),
      ].join("\n")
    : "Belum ada history extract.";
}

function buildSettingsStatusMessage(): string {
  const subtitleTimestampEnabled = isSubtitleTimestampEnabled();
  const browserFallbackEnabled = isBrowserFallbackEnabled();
  return [
    "Status pengaturan bot:",
    `• Subtitle timestamp: ${modeLabel(subtitleTimestampEnabled)} (EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(subtitleTimestampEnabled)})`,
    `• Browser fallback: ${modeLabel(browserFallbackEnabled)} (EXTRACT_BROWSER_FALLBACK=${modeEnvValue(browserFallbackEnabled)})`,
  ].join("\n");
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

function languageFlagIcon(languageCode: string): string {
  const country = languageToCountryCode(languageCode);
  if (!country) {
    return "🌐";
  }
  return countryCodeToFlagEmoji(country);
}

function renderSubtitleLanguageList(languages: SubtitleLanguage[]): string {
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

function renderAllYoutubeLanguages(languages: SubtitleLanguage[]): string {
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

function readEnvLines(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  return content.replaceAll(/\r\n/g, "\n").split("\n");
}

function upsertEnvValue(lines: string[], key: string, value: string): string[] {
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

async function writeBrowserFallbackToEnv(
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

function isBrowserFallbackEnabled(): boolean {
  return (process.env.EXTRACT_BROWSER_FALLBACK ?? "0").trim() === "1";
}

async function writeSubtitleTimestampToEnv(
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

function isSubtitleTimestampEnabled(): boolean {
  return (process.env.EXTRACT_SUBTITLE_TIMESTAMP ?? "1").trim() !== "0";
}

function buildSendFileName(path: string, fallbackBaseName: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const baseName = parts.at(-1) ?? "document";
  const ext = baseName.includes(".")
    ? (baseName.split(".").at(-1) ?? "txt")
    : "txt";

  if (!baseName.startsWith("latest.")) {
    return baseName;
  }

  const articleSlug = parts.at(-2) ?? fallbackBaseName;
  return `${articleSlug}.${ext}`;
}

function isScribdSite(site: string): boolean {
  const normalized = site.toLowerCase();
  return normalized === "scribd.com" || normalized.endsWith(".scribd.com");
}

function replaceFileExtension(path: string, nextExtension: string): string {
  if (path.includes(".")) {
    return path.replace(/\.[^.]+$/u, nextExtension);
  }
  return `${path}${nextExtension}`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function exportTextToDocx(textPath: string): Promise<string> {
  const outputPath = replaceFileExtension(textPath, ".docx");
  const rawText = await Bun.file(textPath).text();
  const lines = rawText.replaceAll(/\r\n/g, "\n").split("\n");

  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const paragraphs = lines.map(
    (line) => new Paragraph({ children: [new TextRun(line)] }),
  );
  const doc = new Document({
    sections: [
      {
        children: paragraphs.length > 0 ? paragraphs : [new Paragraph("")],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  await Bun.write(outputPath, buffer);
  return outputPath;
}

async function exportTextToPdf(textPath: string): Promise<string> {
  const outputPath = replaceFileExtension(textPath, ".pdf");
  const rawText = await Bun.file(textPath).text();
  const html = [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'>",
    "<style>",
    "body { font-family: Arial, sans-serif; font-size: 12px; line-height: 1.45; margin: 24px; }",
    "pre { white-space: pre-wrap; word-wrap: break-word; }",
    "</style>",
    "</head><body>",
    `<pre>${escapeHtml(rawText)}</pre>`,
    "</body></html>",
  ].join("");

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}

async function sendScribdExportFiles(
  api: TelegramApi,
  logger: ReturnType<typeof createLogger>,
  chatId: number,
  textFiles: string[],
  onStatus?: (text: string) => Promise<void>,
): Promise<{
  docx: { sent: number; failed: number };
  pdf: { sent: number; failed: number };
  sourceTextFiles: number;
}> {
  const sourceFiles = textFiles.slice(0, 3);
  const docxFiles: string[] = [];
  const pdfFiles: string[] = [];

  for (const textPath of sourceFiles) {
    try {
      const file = Bun.file(textPath);
      if (!(await file.exists())) {
        continue;
      }
      docxFiles.push(await exportTextToDocx(textPath));
    } catch (error) {
      await logger.warn("scribd docx export failed", {
        chatId,
        textPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const file = Bun.file(textPath);
      if (!(await file.exists())) {
        continue;
      }
      pdfFiles.push(await exportTextToPdf(textPath));
    } catch (error) {
      await logger.warn("scribd pdf export failed", {
        chatId,
        textPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const docxStats = await sendFilesBatch(
    api,
    logger,
    chatId,
    "DOCX",
    docxFiles,
    onStatus,
  );
  const pdfStats = await sendFilesBatch(
    api,
    logger,
    chatId,
    "PDF",
    pdfFiles,
    onStatus,
  );

  return {
    docx: docxStats,
    pdf: pdfStats,
    sourceTextFiles: sourceFiles.length,
  };
}

async function autoImportCookieDocument(
  api: TelegramApi,
  logger: ReturnType<typeof createLogger>,
  chatId: number,
  document: NonNullable<TelegramUpdate["message"]>["document"],
  envPath: string,
): Promise<boolean> {
  if (!document?.file_id) {
    return false;
  }

  const fileName = document.file_name?.toLowerCase() ?? "";
  if (fileName && !fileName.includes("cookie")) {
    return false;
  }

  const file = await api.getFilePath(document.file_id);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error("Telegram file_path tidak tersedia");
  }

  const rawCookies = await api.downloadFileText(filePath);
  const cookieMap = extractCookieMapFromNetscape(rawCookies);
  const entries = Object.entries(cookieMap).filter(([, value]) =>
    Boolean(value),
  );

  if (entries.length === 0) {
    throw new Error(
      "File tidak berisi cookie Netscape yang valid atau semua cookie sudah expired.",
    );
  }

  for (const [domain, header] of entries) {
    await writeCookieToEnv(envPath, domain, header);
  }

  const previewDomains = entries.slice(0, 8).map(([domain]) => domain);
  await api.sendMessage(
    chatId,
    [
      `Auto import cookie berhasil (${entries.length} domain).`,
      `Domain: ${previewDomains.join(", ")}${entries.length > previewDomains.length ? ", ..." : ""}`,
      `Tersimpan di ${envPath}. Cookie langsung aktif di process bot ini.`,
      !entries.some(([, header]) => hasCookieName(header, "cf_clearance"))
        ? "Peringatan: tidak ada cf_clearance di file. Untuk situs Cloudflare, extract bisa gagal."
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  await logger.info("auto cookie import success", {
    chatId,
    fileName: document.file_name ?? "unknown",
    envPath,
    domains: entries.length,
  });
  return true;
}

async function sendFilesBatch(
  api: TelegramApi,
  logger: ReturnType<typeof createLogger>,
  chatId: number,
  title: string,
  files: string[],
  onStatus?: (text: string) => Promise<void>,
): Promise<{ sent: number; failed: number }> {
  const limitedFiles = files.slice(0, 5);
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < limitedFiles.length; index += 1) {
    const path = limitedFiles[index];
    if (!path) {
      continue;
    }
    await onStatus?.(
      `⏳ [5/5] Mengirim file ${title.toLowerCase()} ${index + 1}/${limitedFiles.length}`,
    );
    await api.sendChatAction(chatId, "upload_document");
    try {
      const sendFileName = buildSendFileName(path, title.toLowerCase());
      await api.sendDocument(
        chatId,
        path,
        `${title} ${index + 1}/${limitedFiles.length}`,
        sendFileName,
      );
      sent += 1;
      await Bun.sleep(180);
    } catch (error) {
      failed += 1;
      await logger.warn("failed to send document", {
        chatId,
        title,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      await api.sendMessage(
        chatId,
        `Gagal kirim file ${title.toLowerCase()} ${index + 1}: ${path}`,
      );
    }
  }

  if (files.length > limitedFiles.length) {
    await api.sendMessage(
      chatId,
      `File ${title.toLowerCase()} terlalu banyak (${files.length}). Dikirim ${limitedFiles.length} file pertama.`,
    );
  }

  return { sent, failed };
}

async function sendSubtitleFiles(
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

export async function startTelegramBot(configInput: BotConfig): Promise<void> {
  const config = BotConfigSchema.parse(configInput);
  const api = new TelegramApi(config.token);
  const logger = createLogger("telegram-bot");
  const subtitleSessions = new Map<string, PendingSubtitleSelection>();
  let offset: number | undefined;
  const tokenHint = `${config.token.slice(0, 6)}...${config.token.slice(-4)}`;

  await logger.info("bot started", {
    outputRoot: config.outputRoot,
    token: tokenHint,
  });
  try {
    await api.setMyCommands(buildTelegramCommandSuggestions());
    await logger.info("telegram command suggestions synced");
  } catch (error) {
    await logger.warn("failed to sync telegram command suggestions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await api.getUpdates(offset);
      if (updates.length > 0) {
        await logger.debug("updates fetched", { count: updates.length });
      }

      for (const update of updates) {
        try {
          offset = update.update_id + 1;

          cleanupSubtitleSessions(subtitleSessions);

          const callback = update.callback_query;
          if (callback) {
            const menuAction = parseMainMenuCallbackData(callback.data);
            if (menuAction) {
              const callbackChatId = callback.message?.chat.id;
              if (!callbackChatId) {
                await api.answerCallbackQuery(
                  callback.id,
                  "Chat tidak tersedia.",
                );
                continue;
              }

              await api.answerCallbackQuery(callback.id, "Diproses...");
              if (menuAction === "help") {
                await api.sendMessage(
                  callbackChatId,
                  buildHelpMessage(),
                  buildMainMenuKeyboard(),
                );
              } else if (menuAction === "runs") {
                const runs = await readManifest(config.outputRoot);
                await api.sendMessage(
                  callbackChatId,
                  buildRunsMessage(runs, 5),
                );
              } else if (menuAction === "settings") {
                await api.sendMessage(
                  callbackChatId,
                  buildSettingsStatusMessage(),
                );
              } else {
                await api.sendMessage(
                  callbackChatId,
                  buildMenuActionMessage(menuAction),
                  buildMainMenuKeyboard(),
                );
              }
              continue;
            }

            const callbackData = parseSubtitleCallbackData(callback.data);
            if (!callbackData) {
              await api.answerCallbackQuery(callback.id, "Aksi tidak dikenal.");
              continue;
            }

            const callbackChatId = callback.message?.chat.id;
            if (!callbackChatId) {
              await api.answerCallbackQuery(
                callback.id,
                "Chat tidak tersedia.",
              );
              continue;
            }

            const session = subtitleSessions.get(callbackData.sessionId);
            if (!session || session.chatId !== callbackChatId) {
              await api.answerCallbackQuery(
                callback.id,
                "Sesi subtitle sudah expired. Jalankan /subtitle lagi.",
              );
              continue;
            }

            if (!session.languages.has(callbackData.language)) {
              await api.answerCallbackQuery(callback.id, "Bahasa tidak valid.");
              continue;
            }

            await api.answerCallbackQuery(
              callback.id,
              `Memproses subtitle ${callbackData.language}...`,
            );
            await logger.info("subtitle callback selected", {
              chatId: callbackChatId,
              language: callbackData.language,
              title: session.title,
            });

            const statusMessageId = await api.sendMessage(
              callbackChatId,
              buildStatusCard("⏳ [1/4] Menyiapkan subtitle", [
                { label: "URL", value: session.url },
                { label: "Bahasa", value: callbackData.language },
              ]),
            );

            let subtitleResult;
            try {
              await api.editMessage(
                callbackChatId,
                statusMessageId,
                buildStatusCard("⏳ [2/4] Mengunduh subtitle", [
                  { label: "Judul", value: session.title },
                  { label: "Bahasa", value: callbackData.language },
                ]),
              );

              subtitleResult = await downloadSubtitlesAndConvert(
                session.url,
                callbackData.language,
                config.outputRoot,
                { includeTimestamp: isSubtitleTimestampEnabled() },
              );

              await api.editMessage(
                callbackChatId,
                statusMessageId,
                buildStatusCard("⏳ [3/4] Mengirim file subtitle", [
                  { label: "Judul", value: subtitleResult.title },
                  { label: "Bahasa", value: subtitleResult.language },
                  {
                    label: "Timestamp",
                    value: isSubtitleTimestampEnabled() ? "ON" : "OFF",
                  },
                ]),
              );

              const sent = await sendSubtitleFiles(api, callbackChatId, [
                subtitleResult.srtPath,
                subtitleResult.vttPath,
                subtitleResult.txtPath,
                subtitleResult.mdPath,
              ]);

              await api.editMessage(
                callbackChatId,
                statusMessageId,
                buildStatusCard("✅ [4/4] Subtitle selesai", [
                  { label: "Judul", value: subtitleResult.title },
                  { label: "Bahasa", value: subtitleResult.language },
                  {
                    label: "Timestamp",
                    value: isSubtitleTimestampEnabled() ? "ON" : "OFF",
                  },
                  { label: "File terkirim", value: sent.sent },
                  { label: "File gagal", value: sent.failed },
                  { label: "Folder output", value: subtitleResult.outputDir },
                ]),
              );
              await logger.info("subtitle completed", {
                chatId: callbackChatId,
                title: subtitleResult.title,
                language: subtitleResult.language,
                sent: sent.sent,
                failed: sent.failed,
              });
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
              await api.editMessage(
                callbackChatId,
                statusMessageId,
                buildStatusCard("❌ Subtitle gagal diproses", [
                  { label: "Detail", value: errorMessage.slice(0, 350) },
                ]),
              );
              await logger.error("subtitle callback failed", error, {
                chatId: callbackChatId,
                language: callbackData.language,
                url: session.url,
              });
            }
            continue;
          }

          const chatId = update.message?.chat.id;
          const text = update.message?.text?.trim();
          const caption = update.message?.caption?.trim();
          const commandInput = text || caption || "";
          const document = update.message?.document;

          if (!chatId) {
            continue;
          }

          if (document && !commandInput) {
            await logger.info("document received", {
              chatId,
              fileName: document.file_name ?? "unknown",
            });
            const imported = await autoImportCookieDocument(
              api,
              logger,
              chatId,
              document,
              config.envPath,
            );
            if (imported) {
              continue;
            }
          }

          if (!commandInput) {
            continue;
          }

          await logger.info("message received", { chatId, text: commandInput });
          const command = parseTelegramCommand(commandInput);
          const commandRoot = commandInput.split(/\s+/)[0]?.toLowerCase() ?? "";

          if (command.kind === "help") {
            if (commandRoot === "/start" || commandRoot === "/menu") {
              await api.sendMessage(
                chatId,
                buildWelcomeMenuMessage(),
                buildMainMenuKeyboard(),
              );
              continue;
            }
            await api.sendMessage(
              chatId,
              buildHelpMessage(),
              buildMainMenuKeyboard(),
            );
            continue;
          }

          if (command.kind === "runs") {
            const runs = await readManifest(config.outputRoot);
            await api.sendMessage(
              chatId,
              buildRunsMessage(runs, command.limit),
            );
            await logger.info("runs sent", {
              chatId,
              count: Math.min(runs.length, command.limit),
            });
            continue;
          }

          if (command.kind === "subtitleTimestamp") {
            if (command.action === "status") {
              const enabled = isSubtitleTimestampEnabled();
              await api.sendMessage(
                chatId,
                [
                  "Status subtitle timestamp:",
                  `• Mode: ${modeLabel(enabled)}`,
                  `• EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(enabled)}`,
                ].join("\n"),
              );
              continue;
            }

            const enabled = command.action === "on";
            await writeSubtitleTimestampToEnv(config.envPath, enabled);
            await api.sendMessage(
              chatId,
              [
                `Subtitle timestamp berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
                `Mode sekarang: ${modeLabel(enabled)}`,
                `EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(enabled)}`,
                `Disimpan di ${config.envPath} dan langsung aktif di proses bot ini.`,
              ].join("\n"),
            );
            await logger.info("subtitle timestamp mode changed", {
              chatId,
              action: command.action,
              envPath: config.envPath,
            });
            continue;
          }

          if (command.kind === "subtitle") {
            await api.sendChatAction(chatId, "typing");
            const statusMessageId = await api.sendMessage(
              chatId,
              buildStatusCard("⏳ [1/2] Mengecek subtitle", [
                { label: "URL", value: command.url },
              ]),
            );
            const listed = await listAvailableSubtitles(command.url);
            const resolvedOriginal = resolveOriginalLanguage(
              listed.languages,
              listed.originalLanguage,
            );
            const preferred = pickPreferredSubtitleLanguages(
              listed.languages,
              resolvedOriginal,
            );

            if (preferred.length === 0) {
              await api.editMessage(
                chatId,
                statusMessageId,
                buildStatusCard("❌ Subtitle tidak tersedia", [
                  { label: "Judul", value: listed.title },
                  { label: "URL", value: listed.webpageUrl },
                ]),
              );
              continue;
            }

            const sessionId = createSubtitleSessionId();
            subtitleSessions.set(sessionId, {
              chatId,
              url: command.url,
              title: listed.title,
              languages: new Set(preferred.map((item) => item.code)),
              createdAt: Date.now(),
            });

            const keyboard = buildSubtitleKeyboard(sessionId, preferred);
            await api.editMessage(
              chatId,
              statusMessageId,
              [
                buildStatusCard("✅ [2/2] Subtitle ditemukan", [
                  { label: "Judul", value: listed.title },
                  { label: "Extractor", value: listed.extractorKey },
                  { label: "Bahasa original", value: resolvedOriginal ?? "-" },
                  { label: "Bahasa ditampilkan", value: preferred.length },
                  {
                    label: "Timestamp saat ini",
                    value: isSubtitleTimestampEnabled() ? "ON" : "OFF",
                  },
                ]),
                "",
                "Bahasa pilihan (original/en/id):",
                renderSubtitleLanguageList(preferred),
                "",
                "Bahasa YouTube tersedia:",
                renderAllYoutubeLanguages(listed.languages),
                "",
                "Keterangan tombol: [M]=manual, [A]=auto",
                "Pilih bahasa subtitle dari tombol di bawah.",
              ].join("\n"),
            );
            await api.sendMessage(chatId, "Pilih bahasa subtitle:", keyboard);

            await logger.info("subtitle listed", {
              chatId,
              title: listed.title,
              url: listed.webpageUrl,
              languages: listed.languages.length,
            });
            continue;
          }

          if (command.kind === "browserMode") {
            if (command.action === "status") {
              const enabled = isBrowserFallbackEnabled();
              await api.sendMessage(
                chatId,
                [
                  "Status browser fallback:",
                  `• Mode: ${modeLabel(enabled)}`,
                  `• EXTRACT_BROWSER_FALLBACK=${modeEnvValue(enabled)}`,
                ].join("\n"),
              );
              continue;
            }

            const enabled = command.action === "on";
            await writeBrowserFallbackToEnv(config.envPath, enabled);
            await api.sendMessage(
              chatId,
              [
                `Browser fallback berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
                `Mode sekarang: ${modeLabel(enabled)}`,
                `EXTRACT_BROWSER_FALLBACK=${modeEnvValue(enabled)}`,
                `Disimpan di ${config.envPath} dan langsung aktif di proses bot ini.`,
              ].join("\n"),
            );
            await logger.info("browser mode changed", {
              chatId,
              action: command.action,
              envPath: config.envPath,
            });
            continue;
          }

          if (command.kind === "extract") {
            const extractStartedAt = Date.now();
            let lastStatusText = "";
            let lastStatusAt = 0;
            let liveStatusText = "";
            let lastProgressAt = Date.now();
            const safeStatusUpdate = async (
              messageId: number,
              textValue: string,
            ): Promise<void> => {
              const now = Date.now();
              const isFinal =
                textValue.startsWith("✅") || textValue.includes("[5/5]");
              if (textValue === lastStatusText) {
                return;
              }
              if (!isFinal && now - lastStatusAt < 900) {
                return;
              }

              try {
                await api.sendChatAction(chatId, "typing");
                await api.editMessage(chatId, messageId, textValue);
                lastStatusText = textValue;
                lastStatusAt = now;
              } catch (error) {
                await logger.warn("status update failed", {
                  chatId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            };

            await api.sendChatAction(chatId, "typing");
            const statusMessageId = await api.sendMessage(
              chatId,
              buildStatusCard("⏳ [1/5] Memulai extract", [
                { label: "URL", value: command.url },
                { label: "Maks halaman", value: command.maxPages },
              ]),
            );
            liveStatusText = buildStatusCard("⏳ [1/5] Memulai extract", [
              { label: "URL", value: command.url },
              { label: "Maks halaman", value: command.maxPages },
            ]);
            await logger.info("extract started", {
              chatId,
              url: command.url,
              maxPages: command.maxPages,
            });

            const heartbeat = setInterval(async () => {
              try {
                const now = Date.now();
                if (now - lastProgressAt < 12_000) {
                  return;
                }
                const elapsed = Math.floor((now - extractStartedAt) / 1000);
                await safeStatusUpdate(
                  statusMessageId,
                  `${liveStatusText}\n${renderField("Durasi proses", `${elapsed}s`)}`,
                );
              } catch {
                // noop
              }
            }, 12_000);

            let extraction;
            try {
              extraction = await runExtraction(
                {
                  rootUrl: command.url,
                  maxPages: command.maxPages,
                  outputRoot: config.outputRoot,
                },
                {
                  onProgress: async (progress) => {
                    const statusMap: Record<string, string> = {
                      init: "⏳ [1/5] Menyiapkan proses",
                      crawl: "⏳ [2/5] Mengambil konten website",
                      files: "⏳ [3/5] Menyusun file MD/TXT",
                      save: "⏳ [4/5] Menyimpan hasil",
                      done: "⏳ [5/5] Menyelesaikan proses",
                    };
                    const prefix =
                      statusMap[progress.step] ?? "⏳ [..] Processing";
                    const statusText = buildStatusCard(prefix, [
                      { label: "Detail", value: progress.message },
                    ]);
                    liveStatusText = statusText;
                    lastProgressAt = Date.now();
                    await logger.info("extract progress", {
                      chatId,
                      url: command.url,
                      step: progress.step,
                      detail: progress.message,
                    });

                    await safeStatusUpdate(statusMessageId, statusText);
                  },
                },
              );
            } finally {
              clearInterval(heartbeat);
            }

            await safeStatusUpdate(
              statusMessageId,
              buildStatusCard("✅ [5/5] Extract selesai", [
                { label: "Status", value: "Sedang mengirim file hasil" },
              ]),
            );
            await api.sendChatAction(chatId, "upload_document");

            await api.sendMessage(
              chatId,
              buildStatusCard("Ringkasan hasil extract", [
                { label: "Run ID", value: extraction.runId },
                { label: "Site", value: extraction.site },
                {
                  label: "Halaman dicrawl",
                  value: extraction.result.crawledPages,
                },
                {
                  label: "File markdown",
                  value: extraction.markdownFiles.length,
                },
                { label: "File text", value: extraction.textFiles.length },
                { label: "Result JSON", value: extraction.resultFile },
              ]),
            );

            try {
              const resultJsonName = `${extraction.site}__extract.json`;
              await api.sendDocument(
                chatId,
                extraction.resultFile,
                "Result JSON",
                resultJsonName,
              );
            } catch (error) {
              await logger.warn("failed to send result json", {
                chatId,
                path: extraction.resultFile,
                error: error instanceof Error ? error.message : String(error),
              });
              await api.sendMessage(
                chatId,
                `Gagal kirim Result JSON: ${extraction.resultFile}`,
              );
            }
            await api.sendChatAction(chatId, "upload_document");
            const markdownStats = await sendFilesBatch(
              api,
              logger,
              chatId,
              "Markdown",
              extraction.markdownFiles,
              (textValue) => safeStatusUpdate(statusMessageId, textValue),
            );
            const textStats = await sendFilesBatch(
              api,
              logger,
              chatId,
              "Text",
              extraction.textFiles,
              (textValue) => safeStatusUpdate(statusMessageId, textValue),
            );
            let scribdStats: {
              docx: { sent: number; failed: number };
              pdf: { sent: number; failed: number };
              sourceTextFiles: number;
            } | null = null;

            if (
              isScribdSite(extraction.site) &&
              extraction.textFiles.length > 0
            ) {
              await safeStatusUpdate(
                statusMessageId,
                buildStatusCard("⏳ [5/5] Menyiapkan file Scribd", [
                  { label: "Status", value: "Konversi ke DOCX dan PDF" },
                ]),
              );
              scribdStats = await sendScribdExportFiles(
                api,
                logger,
                chatId,
                extraction.textFiles,
                (textValue) => safeStatusUpdate(statusMessageId, textValue),
              );
            }

            await safeStatusUpdate(
              statusMessageId,
              buildStatusCard("✅ [5/5] Proses selesai", [
                {
                  label: "Markdown (terkirim/gagal)",
                  value: `${markdownStats.sent}/${markdownStats.failed}`,
                },
                {
                  label: "Text (terkirim/gagal)",
                  value: `${textStats.sent}/${textStats.failed}`,
                },
                ...(scribdStats
                  ? [
                      {
                        label: "DOCX (terkirim/gagal)",
                        value: `${scribdStats.docx.sent}/${scribdStats.docx.failed}`,
                      },
                      {
                        label: "PDF (terkirim/gagal)",
                        value: `${scribdStats.pdf.sent}/${scribdStats.pdf.failed}`,
                      },
                    ]
                  : []),
              ]),
            );
            await logger.info("extract completed", {
              chatId,
              runId: extraction.runId,
              site: extraction.site,
              crawledPages: extraction.result.crawledPages,
              durationMs: Date.now() - extractStartedAt,
            });
            continue;
          }

          if (command.kind === "cookieSet") {
            await writeCookieToEnv(
              config.envPath,
              command.domain,
              command.cookie,
            );
            await api.sendMessage(
              chatId,
              [
                `Cookie untuk domain ${command.domain} tersimpan ke ${config.envPath}. Cookie langsung aktif.`,
                !hasCookieName(command.cookie, "cf_clearance")
                  ? "Peringatan: cookie belum berisi cf_clearance. Untuk situs Cloudflare, extract bisa gagal."
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            await logger.info("cookie set from command", {
              chatId,
              domain: command.domain,
              envPath: config.envPath,
            });
            continue;
          }

          if (command.kind === "cookieImport") {
            if (!document?.file_id) {
              await api.sendMessage(
                chatId,
                [
                  "Format belum tepat untuk import cookie domain spesifik.",
                  "Gunakan /cookieimport <domain> di caption saat upload cookies.txt.",
                  "Contoh: /cookieimport projectmultatuli.org",
                ].join("\n"),
              );
              continue;
            }

            await api.sendChatAction(chatId, "typing");
            const file = await api.getFilePath(document.file_id);
            const filePath = file.file_path;

            if (!filePath) {
              throw new Error("Telegram file_path tidak tersedia");
            }

            const rawCookies = await api.downloadFileText(filePath);
            const cookieHeader = extractCookieHeaderFromNetscape(
              rawCookies,
              command.domain,
            );

            if (!cookieHeader) {
              throw new Error(
                `Cookie untuk domain ${command.domain} tidak ditemukan di file`,
              );
            }

            await writeCookieToEnv(
              config.envPath,
              command.domain,
              cookieHeader,
            );
            await api.sendMessage(
              chatId,
              [
                `Cookie domain ${command.domain} berhasil diimport.`,
                `Tersimpan di ${config.envPath}.`,
                "Cookie langsung aktif di process bot ini.",
                !hasCookieName(cookieHeader, "cf_clearance")
                  ? "Peringatan: cookie domain ini belum berisi cf_clearance. Untuk situs Cloudflare, extract bisa gagal."
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            await logger.info("cookie imported from telegram file", {
              chatId,
              domain: command.domain,
              fileName: document.file_name ?? "unknown",
              envPath: config.envPath,
            });
            continue;
          }

          if (document && command.kind === "unknown") {
            const imported = await autoImportCookieDocument(
              api,
              logger,
              chatId,
              document,
              config.envPath,
            );
            if (imported) {
              continue;
            }
          }

          await api.sendMessage(
            chatId,
            buildUnknownCommandMessage(commandInput),
          );
          await logger.warn("unknown command", { chatId, text: commandInput });
        } catch (error) {
          const chatId = update.message?.chat.id;
          await logger.error("failed to process update", error, {
            updateId: update.update_id,
            chatId: chatId ?? "unknown",
          });
          if (chatId) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";
            await api.sendMessage(
              chatId,
              [
                "Terjadi error saat memproses perintah.",
                `Detail: ${errorMessage.slice(0, 350)}`,
                "",
                "Coba ulangi perintah atau ketik /help untuk panduan.",
              ].join("\n"),
            );
          }
        }
      }
    } catch (error) {
      await logger.error("polling loop error", error);
      await Bun.sleep(2000);
    }
  }
}
