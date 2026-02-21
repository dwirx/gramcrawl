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
}

function buildHelpMessage(): string {
  return [
    "Perintah bot:",
    "/extract <url> [maxPages] - ekstrak website ke JSON + Markdown",
    "/subtitle <url> - tampilkan subtitle tersedia (pilih via tombol)",
    "/subtitletimestamp <on|off|status> - kontrol timestamp di hasil subtitle MD/TXT",
    "/browser <on|off|status> - kontrol browser fallback",
    "Upload cookies.txt (tanpa command) - auto import semua domain",
    "/cookieimport <domain> + upload file cookies.txt",
    "/cookieset <domain> <cookie-header>",
    "/runs [limit] - lihat riwayat extract",
    "/help - bantuan",
    "",
    "Anda juga bisa kirim URL langsung tanpa command.",
  ].join("\n");
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
              [
                "⏳ [1/4] Menyiapkan subtitle",
                `URL: ${session.url}`,
                `Bahasa: ${callbackData.language}`,
              ].join("\n"),
            );

            let subtitleResult;
            try {
              await api.editMessage(
                callbackChatId,
                statusMessageId,
                [
                  "⏳ [2/4] Mengunduh subtitle",
                  `Judul: ${session.title}`,
                  `Bahasa: ${callbackData.language}`,
                ].join("\n"),
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
                [
                  "⏳ [3/4] Mengirim file subtitle",
                  `Judul: ${subtitleResult.title}`,
                  `Bahasa: ${subtitleResult.language}`,
                  `Timestamp: ${isSubtitleTimestampEnabled() ? "ON" : "OFF"}`,
                ].join("\n"),
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
                [
                  "✅ [4/4] Subtitle selesai",
                  `Judul: ${subtitleResult.title}`,
                  `Bahasa: ${subtitleResult.language}`,
                  `Timestamp: ${isSubtitleTimestampEnabled() ? "ON" : "OFF"}`,
                  `Terkirim: ${sent.sent}`,
                  `Gagal: ${sent.failed}`,
                  `Folder: ${subtitleResult.outputDir}`,
                ].join("\n"),
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
                `❌ Subtitle gagal diproses\nDetail: ${errorMessage.slice(0, 350)}`,
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

          if (command.kind === "help") {
            await api.sendMessage(chatId, buildHelpMessage());
            continue;
          }

          if (command.kind === "runs") {
            const runs = await readManifest(config.outputRoot);
            const lines = runs
              .slice(0, command.limit)
              .map(
                (run) =>
                  `${run.id} | site=${run.site} | pages=${run.crawledPages} | md=${run.articleFiles}\n${run.rootUrl}`,
              );

            await api.sendMessage(
              chatId,
              lines.length > 0
                ? lines.join("\n\n")
                : "Belum ada history extract.",
            );
            await logger.info("runs sent", { chatId, count: lines.length });
            continue;
          }

          if (command.kind === "subtitleTimestamp") {
            if (command.action === "status") {
              const enabled = isSubtitleTimestampEnabled();
              await api.sendMessage(
                chatId,
                `Subtitle timestamp: ${enabled ? "AKTIF" : "NONAKTIF"}\nEXTRACT_SUBTITLE_TIMESTAMP=${enabled ? "1" : "0"}`,
              );
              continue;
            }

            const enabled = command.action === "on";
            await writeSubtitleTimestampToEnv(config.envPath, enabled);
            await api.sendMessage(
              chatId,
              [
                `Subtitle timestamp berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
                `EXTRACT_SUBTITLE_TIMESTAMP=${enabled ? "1" : "0"}`,
                `Tersimpan di ${config.envPath} dan langsung aktif di proses bot ini.`,
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
              `⏳ [1/2] Mengecek subtitle\nURL: ${command.url}`,
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
                [
                  "❌ Subtitle tidak tersedia.",
                  `Judul: ${listed.title}`,
                  `URL: ${listed.webpageUrl}`,
                ].join("\n"),
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
                "✅ [2/2] Subtitle ditemukan",
                `Judul: ${listed.title}`,
                `Extractor: ${listed.extractorKey}`,
                `Original: ${resolvedOriginal ?? "-"}`,
                `Ditampilkan: ${preferred.length} bahasa`,
                `Timestamp saat ini: ${isSubtitleTimestampEnabled() ? "ON" : "OFF"}`,
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
                `Browser fallback: ${enabled ? "AKTIF" : "NONAKTIF"}\nEXTRACT_BROWSER_FALLBACK=${enabled ? "1" : "0"}`,
              );
              continue;
            }

            const enabled = command.action === "on";
            await writeBrowserFallbackToEnv(config.envPath, enabled);
            await api.sendMessage(
              chatId,
              [
                `Browser fallback berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
                `EXTRACT_BROWSER_FALLBACK=${enabled ? "1" : "0"}`,
                `Tersimpan di ${config.envPath} dan langsung aktif di proses bot ini.`,
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
              `⏳ [1/5] Memulai extract\nURL: ${command.url}\nmaxPages=${command.maxPages}`,
            );
            liveStatusText = `⏳ [1/5] Memulai extract\nURL: ${command.url}\nmaxPages=${command.maxPages}`;
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
                  `${liveStatusText}\nSedang diproses... ${elapsed}s`,
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
                    const statusText = `${prefix}\n${progress.message}`;
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
              "✅ Extract selesai, sedang mengirim file...",
            );
            await api.sendChatAction(chatId, "upload_document");

            await api.sendMessage(
              chatId,
              [
                `Selesai. Run ID: ${extraction.runId}`,
                `Site: ${extraction.site}`,
                `Crawled pages: ${extraction.result.crawledPages}`,
                `Markdown files: ${extraction.markdownFiles.length}`,
                `Text files: ${extraction.textFiles.length}`,
                `Result: ${extraction.resultFile}`,
              ].join("\n"),
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
            await safeStatusUpdate(
              statusMessageId,
              [
                "✅ [5/5] Proses selesai",
                `File markdown terkirim: ${markdownStats.sent}, gagal: ${markdownStats.failed}`,
                `File text terkirim: ${textStats.sent}, gagal: ${textStats.failed}`,
              ].join("\n"),
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
                "Gunakan /cookieimport <domain> sebagai caption saat upload file cookies.txt",
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

          await api.sendMessage(chatId, buildHelpMessage());
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
              `Terjadi error saat memproses perintah.\nDetail: ${errorMessage.slice(0, 350)}`,
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
