import { readdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { Page } from "playwright";
import { runExtraction } from "../app/extract-service";
import {
  buildSiteFolderName,
  readManifest,
  writeManifest,
} from "../app/run-store";
import {
  extractCookieHeaderFromNetscape,
  extractCookieMapFromNetscape,
  hasCookieName,
  writeCookieToEnv,
} from "../cli/cookie-env";
import {
  downloadSubtitlesAndConvert,
  getYtDlpStatus,
  listAvailableSubtitles,
  pickBestSubtitleLanguage,
  pickPreferredSubtitleLanguages,
  resolveOriginalLanguage,
  type SubtitleLanguage,
  updateYtDlpBinary,
} from "../subtitle/service";
import { extractWithDefuddle, extractWithMarkdownNew } from "../mark/service";
import { parseTelegramCommand } from "./command-parser";
import { createLogger } from "./logger";
import {
  isTimeoutLikeError,
  pollingTimeoutBackoffMs,
  runWithChatActionHeartbeat,
  shouldLogPollingTimeout,
  type TelegramChatActionLike,
} from "./runtime-utils";

type TelegramApiResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
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
    from?: { id: number };
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

type TelegramChatAction = TelegramChatActionLike;
type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};
type MainMenuAction = "extract" | "subtitle" | "runs" | "settings" | "help";
type TelegramBotCommand = {
  command: string;
  description: string;
};
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_REQUEST_TIMEOUT_MS = 35_000;
const TELEGRAM_MAX_RETRIES = 3;
const SUBTITLE_SESSION_TTL_MS = 15 * 60 * 1_000;
const SUBTITLE_MAX_ACTIVE_SESSIONS = 500;
const EXTRACT_CACHE_DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;
const EXTRACT_CACHE_DEFAULT_MAX_ENTRIES = 200;
const BOT_RATE_LIMIT_DEFAULT_WINDOW_MS = 60 * 1_000;
const BOT_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 8;
const CHAT_QUEUE_MAX_LENGTH = 20;
const CLEAN_CHAT_SCAN_MULTIPLIER = 4;
const EXTRACT_DEFAULT_TIMEOUT_PER_PAGE_MS = 90_000;
const EXTRACT_DEFAULT_TIMEOUT_BASE_MS = 30_000;
const EXTRACT_DEFAULT_TIMEOUT_MAX_MS = 30 * 60 * 1_000;
const BOT_RESTART_EXIT_DELAY_MS = 250;

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
  bestLanguage: string | null;
  createdAt: number;
};

type JobCancelToken = {
  isCancelled: () => boolean;
  signal: AbortSignal;
};

type JobCancelRef = {
  cancelled: boolean;
  abortController: AbortController;
};

type ChatJob = {
  id: string;
  label: string;
  createdAt: number;
  run: (token: JobCancelToken) => Promise<void>;
};

type ChatQueueState = {
  running: ChatJob | null;
  runningCancelRef: JobCancelRef | null;
  queue: ChatJob[];
  startedAt: number;
};

type ExtractCacheEntry = {
  key: string;
  rootUrl: string;
  maxPages: number;
  createdAt: number;
  expiresAt: number;
  extraction: {
    runId: string;
    site: string;
    resultFile: string;
    markdownFiles: string[];
    textFiles: string[];
    crawledPages: number;
  };
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

    throw new Error(
      `Telegram ${method} failed after ${TELEGRAM_MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    return this.requestJson<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
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

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      return await this.requestJson<boolean>("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {
      return false;
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

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveExtractJobTimeoutMs(maxPages: number): number {
  const configured = readPositiveIntEnv("EXTRACT_BOT_JOB_TIMEOUT_MS", 0);
  if (configured > 0) {
    return configured;
  }

  const estimated =
    EXTRACT_DEFAULT_TIMEOUT_BASE_MS +
    Math.max(1, maxPages) * EXTRACT_DEFAULT_TIMEOUT_PER_PAGE_MS;
  return Math.min(estimated, EXTRACT_DEFAULT_TIMEOUT_MAX_MS);
}

function createTimedAbortSignal(
  timeoutMs: number,
  baseSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(`Job timeout (${timeoutMs}ms)`));
  }, timeoutMs);

  const onBaseAbort = (): void => {
    controller.abort(baseSignal.reason ?? new Error("Aborted"));
  };

  if (baseSignal.aborted) {
    onBaseAbort();
  } else {
    baseSignal.addEventListener("abort", onBaseAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      baseSignal.removeEventListener("abort", onBaseAbort);
    },
    didTimeout: () => didTimeout,
  };
}

function buildExtractCacheKey(url: string, maxPages: number): string {
  try {
    const normalized = new URL(url).toString();
    return `${normalized}::${maxPages}`;
  } catch {
    return `${url.trim()}::${maxPages}`;
  }
}

function cleanupExtractCache(
  cache: Map<string, ExtractCacheEntry>,
  maxEntries: number,
): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  const overflow = cache.size - maxEntries;
  if (overflow <= 0) {
    return;
  }

  const oldest = [...cache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    cache.delete(key);
  }
}

function parseSiteScope(siteInput: string | undefined): string {
  const raw = siteInput?.trim().toLowerCase() ?? "";
  if (!raw) {
    return "";
  }

  if (raw.includes("://")) {
    return buildSiteFolderName(raw);
  }

  if (/^[a-z0-9.-]+$/u.test(raw)) {
    return raw;
  }

  return buildSiteFolderName(`https://${raw}`);
}

async function removeDirectoriesByName(
  rootDir: string,
  targetName: string,
): Promise<number> {
  let removed = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = `${current}/${entry.name}`;
      if (entry.name === targetName) {
        await rm(fullPath, { recursive: true, force: true });
        removed += 1;
        continue;
      }

      stack.push(fullPath);
    }
  }

  return removed;
}

function isCommandRateLimited(
  command: ReturnType<typeof parseTelegramCommand>,
): boolean {
  if (
    command.kind === "help" ||
    command.kind === "cancel" ||
    command.kind === "restart" ||
    command.kind === "stats" ||
    command.kind === "clearCache" ||
    command.kind === "cleanOutput" ||
    command.kind === "cleanDownloads" ||
    command.kind === "clearChat"
  ) {
    return false;
  }

  return true;
}

function buildHelpMessage(): string {
  return [
    "TeleExtract Bot - Bantuan",
    "",
    "Perintah utama:",
    "• /extract <url> [maxPages]",
    "  Ekstrak website ke JSON + Markdown + TXT (maxPages 1-30).",
    "• /archive <url> [maxPages]",
    "  Bisa pakai URL biasa atau archive.is/archive.today/archive.ph.",
    "• /scribd <url-scribd>",
    "  Shortcut extract 1 halaman khusus Scribd.",
    "  Bot akan kirim TXT + DOCX + PDF jika konten terbaca.",
    "• /subtitle <url>",
    "  Ambil subtitle YouTube (tombol ⚡ Auto Terbaik + pilih bahasa).",
    "• /mark <url>",
    "  Convert URL ke Markdown via markdown.new.",
    "• /md <url>",
    "  Alias cepat dari /mark.",
    "• /defuddle <url>",
    "  Convert URL ke Markdown via defuddle.md.",
    "• /df <url>",
    "  Alias cepat dari /defuddle.",
    "• /runs [limit]",
    "  Lihat riwayat extract terbaru (limit 1-20).",
    "• /ytdlp <status|version|update>",
    "  Cek versi yt-dlp atau update manual lewat bot.",
    "• /cancel",
    "  Batalkan job aktif (best effort) dan hapus antrian chat ini.",
    "• /stop",
    "  Alias cepat dari /cancel.",
    "• /restart",
    "  Restart proses bot (disarankan jalankan bot via PM2/systemd).",
    "• /stats",
    "  Lihat status bot: queue, cache, memory, rate-limit.",
    "",
    "Pengaturan:",
    "• /subtitletimestamp <on|off|status>",
    "• /timestamp <on|off|status> (alias cepat)",
    "• /browser <on|off|status>",
    "• /clearcache",
    "  Bersihkan cache runtime (extract cache, sesi subtitle, limiter).",
    "• /cleanoutput <all|site>",
    "  Hapus folder output penuh atau per-site.",
    "• /cleandownloads <all|site>",
    "  Bersihkan folder subtitle/download hasil.",
    "• /clearchat [limit]",
    "  Hapus message di chat (best effort, default 20).",
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
      command: "archive",
      description: "Extract mode archive: /archive <url> [maxPages]",
    },
    {
      command: "scribd",
      description: "Extract cepat Scribd: /scribd <url-scribd>",
    },
    {
      command: "subtitle",
      description: "Ambil subtitle YouTube: /subtitle <url>",
    },
    {
      command: "mark",
      description: "Convert URL ke Markdown: /mark <url>",
    },
    {
      command: "md",
      description: "Alias /mark: /md <url>",
    },
    {
      command: "defuddle",
      description: "Convert URL via defuddle.md: /defuddle <url>",
    },
    {
      command: "df",
      description: "Alias /defuddle: /df <url>",
    },
    { command: "runs", description: "Lihat riwayat extract terbaru" },
    {
      command: "ytdlp",
      description: "Status/versi/update yt-dlp: status|version|update",
    },
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
    {
      command: "cancel",
      description: "Batalkan job aktif dan antrian chat ini",
    },
    {
      command: "restart",
      description: "Restart proses bot (butuh process manager)",
    },
    {
      command: "stats",
      description: "Status bot: queue, cache, memory, limiter",
    },
    {
      command: "clearcache",
      description: "Bersihkan cache runtime bot",
    },
    {
      command: "cleanoutput",
      description: "Hapus output: /cleanoutput <all|site>",
    },
    {
      command: "cleandownloads",
      description: "Bersihkan hasil download subtitle",
    },
    {
      command: "clearchat",
      description: "Hapus message chat: /clearchat [limit]",
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

function ytDlpModeLabel(mode: "managed-local" | "configured" | "path"): string {
  if (mode === "managed-local") {
    return "Managed local (.cache/bin)";
  }
  if (mode === "configured") {
    return "Custom (EXTRACT_YT_DLP_BIN)";
  }
  return "PATH system";
}

function ytDlpUpdateMethodLabel(
  method: "download-latest" | "self-update",
): string {
  return method === "download-latest"
    ? "Download latest release"
    : "Self update (-U)";
}

function buildUnknownCommandMessage(input: string): string {
  return [
    "Perintah tidak dikenali.",
    `Input: ${input}`,
    "",
    "Contoh yang benar:",
    "• /extract https://example.com/artikel 1",
    "• /archive https://archive.is/xxxxx/https://example.com/artikel 1",
    "• /archive https://www.nytimes.com/...?... 1",
    "• /scribd https://www.scribd.com/document/123456789/judul",
    "• /subtitle https://www.youtube.com/watch?v=xxxx",
    "• /mark https://si.inc/posts/fdm1/",
    "• /md https://si.inc/posts/fdm1/",
    "• /defuddle https://si.inc/posts/fdm1/",
    "• /df https://si.inc/posts/fdm1/",
    "• /runs 5",
    "• /ytdlp status",
    "• /ytdlp update",
    "• /cancel",
    "• /stop",
    "• /restart",
    "• /stats",
    "• /clearcache",
    "• /cleanoutput all",
    "• /cleanoutput example.com",
    "• /cleandownloads all",
    "• /clearchat 30",
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
      "Bot akan menampilkan tombol ⚡ Auto Terbaik + pilihan bahasa subtitle.",
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
  bestLanguage: string | null,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  if (bestLanguage) {
    rows.push([
      {
        text: `⚡ Auto Terbaik (${bestLanguage})`,
        callback_data: `subtitle:${sessionId}:__auto__`,
      },
    ]);
  }

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

  const overflow = sessions.size - SUBTITLE_MAX_ACTIVE_SESSIONS;
  if (overflow <= 0) {
    return;
  }

  const oldest = [...sessions.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflow);
  for (const [sessionId] of oldest) {
    sessions.delete(sessionId);
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

  try {
    return {
      sessionId,
      language: decodeURIComponent(encodedLanguage),
    };
  } catch {
    return null;
  }
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

function sanitizeDocumentBaseName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[\\/:*?"<>|]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const truncated = normalized.slice(0, 120).trim();
  return truncated || "document";
}

async function readArticleTitleFromLatestJson(
  path: string,
): Promise<string | null> {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const baseName = parts.at(-1) ?? "";

  if (!baseName.startsWith("latest.")) {
    return null;
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return null;
  }

  const latestJsonPath = `${normalized.slice(0, slashIndex)}/latest.json`;
  const latestJsonFile = Bun.file(latestJsonPath);
  if (!(await latestJsonFile.exists())) {
    return null;
  }

  try {
    const parsed = JSON.parse(await latestJsonFile.text()) as {
      articleTitle?: unknown;
      title?: unknown;
    };
    const rawTitle =
      typeof parsed.articleTitle === "string"
        ? parsed.articleTitle
        : typeof parsed.title === "string"
          ? parsed.title
          : "";
    if (!rawTitle.trim()) {
      return null;
    }

    return sanitizeDocumentBaseName(rawTitle);
  } catch {
    return null;
  }
}

export async function buildSendFileNameForExtract(
  path: string,
  fallbackBaseName: string,
): Promise<string> {
  const defaultName = buildSendFileName(path, fallbackBaseName);
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const baseName = parts.at(-1) ?? "";

  if (!baseName.startsWith("latest.")) {
    return defaultName;
  }

  const ext = baseName.includes(".")
    ? (baseName.split(".").at(-1) ?? "txt")
    : "txt";
  const articleTitle = await readArticleTitleFromLatestJson(path);
  if (!articleTitle) {
    return defaultName;
  }

  return `${articleTitle}.${ext}`;
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

type PdfRenderPage = Page;

const PDF_RENDER_BASE_OPTIONS = {
  format: "A4",
  printBackground: true,
  margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
} as const;

function buildPdfHtml(rawText: string): string {
  return [
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

async function renderTextToPdfWithPage(
  textPath: string,
  page: PdfRenderPage,
): Promise<string> {
  const outputPath = replaceFileExtension(textPath, ".pdf");
  const rawText = await Bun.file(textPath).text();
  await page.setContent(buildPdfHtml(rawText), {
    waitUntil: "domcontentloaded",
  });
  await page.pdf({
    path: outputPath,
    ...PDF_RENDER_BASE_OPTIONS,
  });
  return outputPath;
}

async function exportTextToPdf(textPath: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await renderTextToPdfWithPage(textPath, page);
  } finally {
    await browser.close();
  }
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
  let sharedPdfPage: PdfRenderPage | null = null;
  let closeSharedPdfBrowser: (() => Promise<void>) | null = null;

  if (sourceFiles.length > 0) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      sharedPdfPage = await browser.newPage();
      closeSharedPdfBrowser = async () => {
        await browser.close();
      };
    } catch (error) {
      await logger.warn("scribd shared pdf browser init failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    for (const textPath of sourceFiles) {
      const file = Bun.file(textPath);
      if (!(await file.exists())) {
        continue;
      }

      try {
        docxFiles.push(await exportTextToDocx(textPath));
      } catch (error) {
        await logger.warn("scribd docx export failed", {
          chatId,
          textPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        if (sharedPdfPage) {
          pdfFiles.push(await renderTextToPdfWithPage(textPath, sharedPdfPage));
        } else {
          pdfFiles.push(await exportTextToPdf(textPath));
        }
      } catch (error) {
        await logger.warn("scribd pdf export failed", {
          chatId,
          textPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    if (closeSharedPdfBrowser) {
      await closeSharedPdfBrowser().catch(() => {});
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
      const sendFileName = await buildSendFileNameForExtract(
        path,
        title.toLowerCase(),
      );
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
  const extractCache = new Map<string, ExtractCacheEntry>();
  const userRateLimitBuckets = new Map<number, number[]>();
  const chatQueues = new Map<number, ChatQueueState>();
  const botStartedAt = Date.now();
  const extractCacheTtlMs = readPositiveIntEnv(
    "EXTRACT_BOT_CACHE_TTL_MS",
    EXTRACT_CACHE_DEFAULT_TTL_MS,
  );
  const extractCacheMaxEntries = readPositiveIntEnv(
    "EXTRACT_BOT_CACHE_MAX_ENTRIES",
    EXTRACT_CACHE_DEFAULT_MAX_ENTRIES,
  );
  const rateLimitWindowMs = readPositiveIntEnv(
    "EXTRACT_BOT_RATE_LIMIT_WINDOW_MS",
    BOT_RATE_LIMIT_DEFAULT_WINDOW_MS,
  );
  const rateLimitMaxRequests = readPositiveIntEnv(
    "EXTRACT_BOT_RATE_LIMIT_MAX_REQUESTS",
    BOT_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
  );
  let offset: number | undefined;
  const tokenHint = `${config.token.slice(0, 6)}...${config.token.slice(-4)}`;

  const consumeRateLimit = (
    userId: number,
  ): { allowed: boolean; retryAfterSec: number } => {
    const now = Date.now();
    const existing = userRateLimitBuckets.get(userId) ?? [];
    const active = existing.filter(
      (timestamp) => now - timestamp < rateLimitWindowMs,
    );

    if (active.length >= rateLimitMaxRequests) {
      const retryAfterMs = Math.max(
        0,
        (active[0] ?? now) + rateLimitWindowMs - now,
      );
      userRateLimitBuckets.set(userId, active);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    active.push(now);
    userRateLimitBuckets.set(userId, active);
    return { allowed: true, retryAfterSec: 0 };
  };

  const getOrCreateQueueState = (chatId: number): ChatQueueState => {
    const existing = chatQueues.get(chatId);
    if (existing) {
      return existing;
    }

    const created: ChatQueueState = {
      running: null,
      runningCancelRef: null,
      queue: [],
      startedAt: 0,
    };
    chatQueues.set(chatId, created);
    return created;
  };

  const runNextChatJob = (chatId: number): void => {
    const state = getOrCreateQueueState(chatId);
    if (state.running || state.queue.length === 0) {
      return;
    }

    const nextJob = state.queue.shift();
    if (!nextJob) {
      return;
    }

    const cancelRef: JobCancelRef = {
      cancelled: false,
      abortController: new AbortController(),
    };
    state.running = nextJob;
    state.runningCancelRef = cancelRef;
    state.startedAt = Date.now();

    void (async () => {
      try {
        await logger.info("chat job started", {
          chatId,
          label: nextJob.label,
          queued: state.queue.length,
        });
        await runWithChatActionHeartbeat(
          (targetChatId, action) => api.sendChatAction(targetChatId, action),
          chatId,
          "typing",
          async () =>
            nextJob.run({
              isCancelled: () => cancelRef.cancelled,
              signal: cancelRef.abortController.signal,
            }),
        );
      } catch (error) {
        await logger.error("chat job failed", error, {
          chatId,
          label: nextJob.label,
        });
        await api.sendMessage(
          chatId,
          buildStatusCard("❌ Job gagal", [
            { label: "Task", value: nextJob.label },
            {
              label: "Detail",
              value: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 300),
            },
          ]),
        );
      } finally {
        state.running = null;
        state.runningCancelRef = null;
        state.startedAt = 0;
        if (state.queue.length === 0) {
          chatQueues.delete(chatId);
        } else {
          runNextChatJob(chatId);
        }
      }
    })();
  };

  const enqueueChatJob = (
    chatId: number,
    label: string,
    run: ChatJob["run"],
  ): { started: boolean; position: number; queueSize: number } => {
    const state = getOrCreateQueueState(chatId);
    if (state.queue.length >= CHAT_QUEUE_MAX_LENGTH) {
      return {
        started: false,
        position: -1,
        queueSize: state.queue.length + (state.running ? 1 : 0),
      };
    }

    const started = !state.running && state.queue.length === 0;
    const job: ChatJob = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      label,
      createdAt: Date.now(),
      run,
    };
    state.queue.push(job);
    const position = started ? 0 : state.queue.length;
    runNextChatJob(chatId);
    return {
      started,
      position,
      queueSize: state.queue.length + (state.running ? 1 : 0),
    };
  };

  const cancelChatJobs = (
    chatId: number,
  ): {
    queuedCleared: number;
    runningCancelled: boolean;
    runningLabel: string;
  } => {
    const state = chatQueues.get(chatId);
    if (!state) {
      return {
        queuedCleared: 0,
        runningCancelled: false,
        runningLabel: "-",
      };
    }

    const queuedCleared = state.queue.length;
    state.queue = [];
    const runningCancelled = Boolean(state.running && state.runningCancelRef);
    if (state.runningCancelRef) {
      state.runningCancelRef.cancelled = true;
      state.runningCancelRef.abortController.abort(
        new Error("Cancelled from /cancel command"),
      );
    }
    const runningLabel = state.running?.label ?? "-";

    if (!state.running) {
      chatQueues.delete(chatId);
    }

    return { queuedCleared, runningCancelled, runningLabel };
  };

  const queueStats = (): {
    activeChats: number;
    runningJobs: number;
    queuedJobs: number;
  } => {
    let runningJobs = 0;
    let queuedJobs = 0;

    for (const state of chatQueues.values()) {
      if (state.running) {
        runningJobs += 1;
      }
      queuedJobs += state.queue.length;
    }

    return {
      activeChats: chatQueues.size,
      runningJobs,
      queuedJobs,
    };
  };

  const clearRuntimeCaches = (): {
    extractCacheCount: number;
    subtitleSessionCount: number;
    rateLimitCount: number;
  } => {
    const extractCacheCount = extractCache.size;
    const subtitleSessionCount = subtitleSessions.size;
    const rateLimitCount = userRateLimitBuckets.size;

    extractCache.clear();
    subtitleSessions.clear();
    userRateLimitBuckets.clear();

    return { extractCacheCount, subtitleSessionCount, rateLimitCount };
  };

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

  let consecutivePollingTimeouts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await api.getUpdates(offset);
      if (consecutivePollingTimeouts > 0) {
        await logger.info("polling recovered", {
          previousTimeouts: consecutivePollingTimeouts,
        });
        consecutivePollingTimeouts = 0;
      }

      if (updates.length > 0) {
        await logger.debug("updates fetched", { count: updates.length });
      }

      for (const update of updates) {
        try {
          offset = update.update_id + 1;

          cleanupSubtitleSessions(subtitleSessions);
          cleanupExtractCache(extractCache, extractCacheMaxEntries);

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
              if (callbackData.language !== "__auto__") {
                await api.answerCallbackQuery(
                  callback.id,
                  "Bahasa tidak valid.",
                );
                continue;
              }
            }

            const selectedLanguage =
              callbackData.language === "__auto__"
                ? session.bestLanguage
                : callbackData.language;
            if (!selectedLanguage || !session.languages.has(selectedLanguage)) {
              await api.answerCallbackQuery(
                callback.id,
                "Auto subtitle tidak tersedia. Jalankan /subtitle lagi.",
              );
              continue;
            }

            const callbackUserId = callback.from?.id ?? callbackChatId;
            const callbackRateLimit = consumeRateLimit(callbackUserId);
            if (!callbackRateLimit.allowed) {
              await api.answerCallbackQuery(
                callback.id,
                `Terlalu sering. Coba lagi ${callbackRateLimit.retryAfterSec}s.`,
              );
              continue;
            }

            subtitleSessions.delete(callbackData.sessionId);
            const queuedSubtitleJob = enqueueChatJob(
              callbackChatId,
              `subtitle:${selectedLanguage}`,
              async (cancelToken) => {
                await logger.info("subtitle callback selected", {
                  chatId: callbackChatId,
                  requestedLanguage: callbackData.language,
                  language: selectedLanguage,
                  title: session.title,
                });

                if (cancelToken.isCancelled()) {
                  await api.sendMessage(
                    callbackChatId,
                    "Job subtitle dibatalkan sebelum diproses.",
                  );
                  return;
                }

                const statusMessageId = await api.sendMessage(
                  callbackChatId,
                  buildStatusCard("⏳ [1/4] Menyiapkan subtitle", [
                    { label: "URL", value: session.url },
                    { label: "Bahasa", value: selectedLanguage },
                  ]),
                );

                try {
                  await api.editMessage(
                    callbackChatId,
                    statusMessageId,
                    buildStatusCard("⏳ [2/4] Mengunduh subtitle", [
                      { label: "Judul", value: session.title },
                      { label: "Bahasa", value: selectedLanguage },
                    ]),
                  );

                  const subtitleResult = await downloadSubtitlesAndConvert(
                    session.url,
                    selectedLanguage,
                    config.outputRoot,
                    { includeTimestamp: isSubtitleTimestampEnabled() },
                  );

                  if (cancelToken.isCancelled()) {
                    await api.editMessage(
                      callbackChatId,
                      statusMessageId,
                      buildStatusCard("🛑 Subtitle dibatalkan", [
                        { label: "Judul", value: subtitleResult.title },
                        { label: "Bahasa", value: subtitleResult.language },
                      ]),
                    );
                    return;
                  }

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
                      {
                        label: "Folder output",
                        value: subtitleResult.outputDir,
                      },
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
                    requestedLanguage: callbackData.language,
                    language: selectedLanguage,
                    url: session.url,
                  });
                }
              },
            );

            if (queuedSubtitleJob.position < 0) {
              await api.answerCallbackQuery(callback.id, "Antrian penuh.");
              await api.sendMessage(
                callbackChatId,
                "Antrian sedang penuh. Coba lagi beberapa saat.",
              );
              continue;
            }

            if (queuedSubtitleJob.started) {
              await api.answerCallbackQuery(
                callback.id,
                `Memproses subtitle ${selectedLanguage}...`,
              );
            } else {
              await api.answerCallbackQuery(
                callback.id,
                `Masuk antrian #${queuedSubtitleJob.position}`,
              );
              await api.sendMessage(
                callbackChatId,
                `⏳ Job subtitle masuk antrian #${queuedSubtitleJob.position}.`,
              );
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
          const userId = update.message?.from?.id ?? chatId;

          if (isCommandRateLimited(command)) {
            const commandRateLimit = consumeRateLimit(userId);
            if (!commandRateLimit.allowed) {
              await api.sendMessage(
                chatId,
                `Terlalu banyak request. Coba lagi dalam ${commandRateLimit.retryAfterSec} detik.`,
              );
              continue;
            }
          }

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

          if (command.kind === "cancel") {
            const cancelled = cancelChatJobs(chatId);
            await api.sendMessage(
              chatId,
              buildStatusCard("Status cancel job", [
                {
                  label: "Running dibatalkan",
                  value: cancelled.runningCancelled ? "YA" : "TIDAK",
                },
                { label: "Job aktif", value: cancelled.runningLabel },
                { label: "Antrian dihapus", value: cancelled.queuedCleared },
              ]),
            );
            continue;
          }

          if (command.kind === "restart") {
            const cancelled = cancelChatJobs(chatId);
            await api.sendMessage(
              chatId,
              buildStatusCard(
                "🔁 Restart bot",
                [
                  {
                    label: "Running dibatalkan",
                    value: cancelled.runningCancelled ? "YA" : "TIDAK",
                  },
                  { label: "Antrian dihapus", value: cancelled.queuedCleared },
                ],
                "Bot akan restart sekarang. Gunakan PM2/systemd/docker restart policy agar bot otomatis hidup lagi.",
              ),
            );
            await logger.warn("restart requested from telegram", {
              chatId,
              runningCancelled: cancelled.runningCancelled,
              queuedCleared: cancelled.queuedCleared,
            });
            setTimeout(() => {
              process.exit(0);
            }, BOT_RESTART_EXIT_DELAY_MS);
            continue;
          }

          if (command.kind === "stats") {
            cleanupExtractCache(extractCache, extractCacheMaxEntries);
            cleanupSubtitleSessions(subtitleSessions);
            const queue = queueStats();
            const memory = process.memoryUsage();
            const uptimeSec = Math.floor((Date.now() - botStartedAt) / 1000);
            await api.sendMessage(
              chatId,
              buildStatusCard("Bot runtime stats", [
                { label: "Uptime", value: `${uptimeSec}s` },
                { label: "Queue chat aktif", value: queue.activeChats },
                { label: "Queue running", value: queue.runningJobs },
                { label: "Queue menunggu", value: queue.queuedJobs },
                { label: "Extract cache", value: extractCache.size },
                { label: "Subtitle session", value: subtitleSessions.size },
                { label: "Rate buckets", value: userRateLimitBuckets.size },
                {
                  label: "RSS",
                  value: `${Math.round(memory.rss / (1024 * 1024))} MB`,
                },
                {
                  label: "Heap used",
                  value: `${Math.round(memory.heapUsed / (1024 * 1024))} MB`,
                },
              ]),
            );
            continue;
          }

          if (command.kind === "clearCache") {
            const cleared = clearRuntimeCaches();
            await api.sendMessage(
              chatId,
              buildStatusCard("Cache runtime dibersihkan", [
                { label: "Extract cache", value: cleared.extractCacheCount },
                {
                  label: "Subtitle session",
                  value: cleared.subtitleSessionCount,
                },
                { label: "Rate bucket", value: cleared.rateLimitCount },
              ]),
            );
            continue;
          }

          if (command.kind === "cleanOutput") {
            if (command.scope === "all") {
              await rm(`${config.outputRoot}/sites`, {
                recursive: true,
                force: true,
              });
              await rm(`${config.outputRoot}/runs-manifest.json`, {
                force: true,
              });
              extractCache.clear();
              await api.sendMessage(
                chatId,
                "Output berhasil dibersihkan untuk semua site.",
              );
              continue;
            }

            const site = parseSiteScope(command.site);
            if (!site) {
              await api.sendMessage(
                chatId,
                "Format site tidak valid. Gunakan /cleanoutput <all|site>.",
              );
              continue;
            }

            await rm(`${config.outputRoot}/sites/${site}`, {
              recursive: true,
              force: true,
            });

            const runs = await readManifest(config.outputRoot);
            const filtered = runs.filter((item) => item.site !== site);
            await writeManifest(config.outputRoot, filtered);
            for (const [cacheKey, entry] of extractCache) {
              if (entry.extraction.site === site) {
                extractCache.delete(cacheKey);
              }
            }

            await api.sendMessage(
              chatId,
              `Output site ${site} berhasil dihapus.`,
            );
            continue;
          }

          if (command.kind === "cleanDownloads") {
            const site = parseSiteScope(command.site);
            const root =
              command.scope === "all"
                ? `${config.outputRoot}/sites`
                : `${config.outputRoot}/sites/${site}`;

            if (command.scope === "site" && !site) {
              await api.sendMessage(
                chatId,
                "Format site tidak valid. Gunakan /cleandownloads <all|site>.",
              );
              continue;
            }

            const removedDirs = await removeDirectoriesByName(
              root,
              "subtitles",
            );
            await api.sendMessage(
              chatId,
              `Cleanup download selesai. Folder subtitles terhapus: ${removedDirs}.`,
            );
            continue;
          }

          if (command.kind === "clearChat") {
            const anchorId = update.message?.message_id;
            if (!anchorId) {
              await api.sendMessage(chatId, "Message anchor tidak tersedia.");
              continue;
            }

            let deleted = 0;
            const maxScan = Math.max(
              command.limit,
              command.limit * CLEAN_CHAT_SCAN_MULTIPLIER,
            );
            for (
              let offsetIndex = 0;
              offsetIndex < maxScan && deleted < command.limit;
              offsetIndex += 1
            ) {
              const targetMessageId = anchorId - offsetIndex;
              if (targetMessageId <= 0) {
                break;
              }

              const ok = await api.deleteMessage(chatId, targetMessageId);
              if (ok) {
                deleted += 1;
              }
            }

            await api.sendMessage(
              chatId,
              `Clear chat selesai. Message terhapus: ${deleted}/${command.limit}.`,
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
            const queuedSubtitleListJob = enqueueChatJob(
              chatId,
              `subtitle:list:${command.url}`,
              async (cancelToken) => {
                await api.sendChatAction(chatId, "typing");
                const statusMessageId = await api.sendMessage(
                  chatId,
                  buildStatusCard("⏳ [1/2] Mengecek subtitle", [
                    { label: "URL", value: command.url },
                  ]),
                );

                try {
                  if (cancelToken.isCancelled()) {
                    await api.editMessage(
                      chatId,
                      statusMessageId,
                      "🛑 Job subtitle dibatalkan.",
                    );
                    return;
                  }

                  const listed = await listAvailableSubtitles(command.url);
                  const resolvedOriginal = resolveOriginalLanguage(
                    listed.languages,
                    listed.originalLanguage,
                  );
                  const preferred = pickPreferredSubtitleLanguages(
                    listed.languages,
                    resolvedOriginal,
                  );
                  const bestLanguage = pickBestSubtitleLanguage(
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
                    return;
                  }

                  const sessionId = createSubtitleSessionId();
                  subtitleSessions.set(sessionId, {
                    chatId,
                    url: command.url,
                    title: listed.title,
                    languages: new Set(
                      [
                        ...preferred.map((item) => item.code),
                        bestLanguage?.code ?? "",
                      ].filter(Boolean),
                    ),
                    bestLanguage: bestLanguage?.code ?? null,
                    createdAt: Date.now(),
                  });
                  cleanupSubtitleSessions(subtitleSessions);

                  const keyboard = buildSubtitleKeyboard(
                    sessionId,
                    preferred,
                    bestLanguage?.code ?? null,
                  );
                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    [
                      buildStatusCard("✅ [2/2] Subtitle ditemukan", [
                        { label: "Judul", value: listed.title },
                        { label: "Extractor", value: listed.extractorKey },
                        {
                          label: "Bahasa original",
                          value: resolvedOriginal ?? "-",
                        },
                        {
                          label: "Bahasa ditampilkan",
                          value: preferred.length,
                        },
                        {
                          label: "Auto terbaik",
                          value: bestLanguage?.code ?? "-",
                        },
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
                  await api.sendMessage(
                    chatId,
                    "Pilih bahasa subtitle:",
                    keyboard,
                  );

                  await logger.info("subtitle listed", {
                    chatId,
                    title: listed.title,
                    url: listed.webpageUrl,
                    languages: listed.languages.length,
                    bestLanguage: bestLanguage?.code ?? null,
                  });
                } catch (error) {
                  const detail =
                    error instanceof Error ? error.message : String(error);
                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("❌ Gagal mengecek subtitle", [
                      { label: "URL", value: command.url },
                      { label: "Detail", value: detail.slice(0, 350) },
                    ]),
                  );
                  await logger.error("subtitle list failed", error, {
                    chatId,
                    url: command.url,
                  });
                }
              },
            );

            if (queuedSubtitleListJob.position < 0) {
              await api.sendMessage(
                chatId,
                "Antrian subtitle penuh. Coba lagi beberapa saat.",
              );
              continue;
            }

            if (!queuedSubtitleListJob.started) {
              await api.sendMessage(
                chatId,
                `⏳ Job subtitle masuk antrian #${queuedSubtitleListJob.position}.`,
              );
            }
            continue;
          }

          if (command.kind === "mark") {
            const queuedMarkJob = enqueueChatJob(
              chatId,
              `mark:${command.url}`,
              async (cancelToken) => {
                await api.sendChatAction(chatId, "typing");
                const statusMessageId = await api.sendMessage(
                  chatId,
                  buildStatusCard("⏳ [1/3] Memproses /mark", [
                    { label: "URL", value: command.url },
                  ]),
                );

                try {
                  const marked = await extractWithMarkdownNew(
                    command.url,
                    config.outputRoot,
                  );

                  if (cancelToken.isCancelled()) {
                    await api.editMessage(
                      chatId,
                      statusMessageId,
                      "🛑 Job /mark dibatalkan.",
                    );
                    return;
                  }

                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("✅ [2/3] Markdown berhasil dibuat", [
                      { label: "Title", value: marked.title },
                      { label: "Method", value: marked.method },
                      {
                        label: "Tokens",
                        value: marked.tokens ?? "n/a",
                      },
                    ]),
                  );

                  await api.sendChatAction(chatId, "upload_document");
                  await api.sendDocument(
                    chatId,
                    marked.markdownPath,
                    "Markdown (.md)",
                    buildSendFileName(marked.markdownPath, marked.title),
                  );
                  await api.sendChatAction(chatId, "upload_document");
                  await api.sendDocument(
                    chatId,
                    marked.textPath,
                    "Markdown mirror (.txt)",
                    buildSendFileName(marked.textPath, marked.title),
                  );

                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("✅ [3/3] /mark selesai", [
                      { label: "Output", value: marked.outputDir },
                      {
                        label: "File",
                        value: [
                          buildSendFileName(marked.markdownPath, marked.title),
                          buildSendFileName(marked.textPath, marked.title),
                        ].join(" + "),
                      },
                    ]),
                  );

                  await logger.info("mark completed", {
                    chatId,
                    url: command.url,
                    title: marked.title,
                    method: marked.method,
                    tokens: marked.tokens,
                  });
                } catch (error) {
                  const detail =
                    error instanceof Error ? error.message : String(error);
                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("❌ /mark gagal", [
                      { label: "Detail", value: detail.slice(0, 350) },
                    ]),
                  );
                  await logger.error("mark failed", error, {
                    chatId,
                    url: command.url,
                  });
                }
              },
            );

            if (queuedMarkJob.position < 0) {
              await api.sendMessage(chatId, "Antrian /mark penuh. Coba lagi.");
              continue;
            }

            if (!queuedMarkJob.started) {
              await api.sendMessage(
                chatId,
                `⏳ Job /mark masuk antrian #${queuedMarkJob.position}.`,
              );
            }
            continue;
          }

          if (command.kind === "defuddle") {
            const queuedDefuddleJob = enqueueChatJob(
              chatId,
              `defuddle:${command.url}`,
              async (cancelToken) => {
                await api.sendChatAction(chatId, "typing");
                const statusMessageId = await api.sendMessage(
                  chatId,
                  buildStatusCard("⏳ [1/3] Memproses /defuddle", [
                    { label: "URL", value: command.url },
                  ]),
                );

                try {
                  const extracted = await extractWithDefuddle(
                    command.url,
                    config.outputRoot,
                  );

                  if (cancelToken.isCancelled()) {
                    await api.editMessage(
                      chatId,
                      statusMessageId,
                      "🛑 Job /defuddle dibatalkan.",
                    );
                    return;
                  }

                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("✅ [2/3] Defuddle berhasil dibuat", [
                      { label: "Title", value: extracted.title },
                      { label: "Method", value: extracted.method },
                    ]),
                  );

                  await api.sendChatAction(chatId, "upload_document");
                  await api.sendDocument(
                    chatId,
                    extracted.markdownPath,
                    "Defuddle markdown (.md)",
                    buildSendFileName(extracted.markdownPath, extracted.title),
                  );
                  await api.sendChatAction(chatId, "upload_document");
                  await api.sendDocument(
                    chatId,
                    extracted.textPath,
                    "Defuddle mirror (.txt)",
                    buildSendFileName(extracted.textPath, extracted.title),
                  );

                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("✅ [3/3] /defuddle selesai", [
                      { label: "Output", value: extracted.outputDir },
                      {
                        label: "File",
                        value: [
                          buildSendFileName(
                            extracted.markdownPath,
                            extracted.title,
                          ),
                          buildSendFileName(
                            extracted.textPath,
                            extracted.title,
                          ),
                        ].join(" + "),
                      },
                    ]),
                  );

                  await logger.info("defuddle completed", {
                    chatId,
                    url: command.url,
                    title: extracted.title,
                    method: extracted.method,
                  });
                } catch (error) {
                  const detail =
                    error instanceof Error ? error.message : String(error);
                  await api.editMessage(
                    chatId,
                    statusMessageId,
                    buildStatusCard("❌ /defuddle gagal", [
                      { label: "Detail", value: detail.slice(0, 350) },
                    ]),
                  );
                  await logger.error("defuddle failed", error, {
                    chatId,
                    url: command.url,
                  });
                }
              },
            );

            if (queuedDefuddleJob.position < 0) {
              await api.sendMessage(
                chatId,
                "Antrian /defuddle penuh. Coba lagi.",
              );
              continue;
            }

            if (!queuedDefuddleJob.started) {
              await api.sendMessage(
                chatId,
                `⏳ Job /defuddle masuk antrian #${queuedDefuddleJob.position}.`,
              );
            }
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

          if (command.kind === "ytDlp") {
            await api.sendChatAction(chatId, "typing");
            const statusMessageId = await api.sendMessage(
              chatId,
              buildStatusCard(
                command.action === "update"
                  ? "⏳ [1/2] Menyiapkan update yt-dlp"
                  : "⏳ [1/1] Mengecek yt-dlp",
                [{ label: "Aksi", value: command.action }],
              ),
            );

            try {
              if (command.action === "update") {
                const updated = await updateYtDlpBinary();

                await api.editMessage(
                  chatId,
                  statusMessageId,
                  buildStatusCard("✅ [2/2] yt-dlp berhasil diupdate", [
                    {
                      label: "Metode",
                      value: ytDlpUpdateMethodLabel(updated.method),
                    },
                    { label: "Versi sebelum", value: updated.before.version },
                    { label: "Versi sesudah", value: updated.after.version },
                    {
                      label: "Mode binary",
                      value: ytDlpModeLabel(updated.after.mode),
                    },
                    {
                      label: "Auto update",
                      value: updated.after.autoUpdateEnabled ? "ON" : "OFF",
                    },
                    { label: "Binary", value: updated.after.binary },
                  ]),
                );

                await logger.info("yt-dlp updated", {
                  chatId,
                  beforeVersion: updated.before.version,
                  afterVersion: updated.after.version,
                  method: updated.method,
                  binary: updated.after.binary,
                });
                continue;
              }

              const status = await getYtDlpStatus();
              const title =
                command.action === "version"
                  ? "✅ Versi yt-dlp"
                  : "✅ Status yt-dlp";
              await api.editMessage(
                chatId,
                statusMessageId,
                buildStatusCard(title, [
                  { label: "Versi", value: status.version },
                  { label: "Mode binary", value: ytDlpModeLabel(status.mode) },
                  {
                    label: "Auto update",
                    value: status.autoUpdateEnabled ? "ON" : "OFF",
                  },
                  { label: "Binary", value: status.binary },
                ]),
              );

              await logger.info("yt-dlp status sent", {
                chatId,
                action: command.action,
                version: status.version,
                mode: status.mode,
                binary: status.binary,
              });
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              await api.editMessage(
                chatId,
                statusMessageId,
                buildStatusCard("❌ Operasi yt-dlp gagal", [
                  { label: "Aksi", value: command.action },
                  { label: "Detail", value: detail.slice(0, 350) },
                ]),
              );
              await logger.error("yt-dlp command failed", error, {
                chatId,
                action: command.action,
              });
            }
            continue;
          }

          if (command.kind === "extract") {
            const queuedExtractJob = enqueueChatJob(
              chatId,
              `extract:${command.url}`,
              async (cancelToken) => {
                const cacheKey = buildExtractCacheKey(
                  command.url,
                  command.maxPages,
                );
                const extractStartedAt = Date.now();
                const extractTimeoutMs = resolveExtractJobTimeoutMs(
                  command.maxPages,
                );
                const timedCancel = createTimedAbortSignal(
                  extractTimeoutMs,
                  cancelToken.signal,
                );
                let lastStatusText = "";
                let lastStatusAt = 0;
                let liveStatusText = "";
                let lastProgressAt = Date.now();
                let heartbeatBusy = false;

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
                      error:
                        error instanceof Error ? error.message : String(error),
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

                const heartbeat = setInterval(async () => {
                  if (heartbeatBusy) {
                    return;
                  }
                  heartbeatBusy = true;
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
                  } finally {
                    heartbeatBusy = false;
                  }
                }, 12_000);

                try {
                  cleanupExtractCache(extractCache, extractCacheMaxEntries);
                  const cached = extractCache.get(cacheKey);
                  if (cached && cached.expiresAt > Date.now()) {
                    const resultFileExists = await Bun.file(
                      cached.extraction.resultFile,
                    ).exists();
                    if (resultFileExists && !cancelToken.isCancelled()) {
                      await safeStatusUpdate(
                        statusMessageId,
                        buildStatusCard("⚡ [cache] Extract dari cache", [
                          { label: "Run ID", value: cached.extraction.runId },
                          { label: "Site", value: cached.extraction.site },
                          {
                            label: "Halaman dicrawl",
                            value: cached.extraction.crawledPages,
                          },
                        ]),
                      );

                      await api.sendChatAction(chatId, "upload_document");
                      await api.sendMessage(
                        chatId,
                        buildStatusCard("Ringkasan hasil extract (cache)", [
                          { label: "Run ID", value: cached.extraction.runId },
                          { label: "Site", value: cached.extraction.site },
                          {
                            label: "Halaman dicrawl",
                            value: cached.extraction.crawledPages,
                          },
                          {
                            label: "File markdown",
                            value: cached.extraction.markdownFiles.length,
                          },
                          {
                            label: "File text",
                            value: cached.extraction.textFiles.length,
                          },
                          {
                            label: "Result JSON",
                            value: cached.extraction.resultFile,
                          },
                        ]),
                      );

                      const resultJsonName = `${cached.extraction.site}__extract.json`;
                      await api.sendDocument(
                        chatId,
                        cached.extraction.resultFile,
                        "Result JSON (cache)",
                        resultJsonName,
                      );
                      const markdownStats = await sendFilesBatch(
                        api,
                        logger,
                        chatId,
                        "Markdown",
                        cached.extraction.markdownFiles,
                        (textValue) =>
                          safeStatusUpdate(statusMessageId, textValue),
                      );
                      const textStats = await sendFilesBatch(
                        api,
                        logger,
                        chatId,
                        "Text",
                        cached.extraction.textFiles,
                        (textValue) =>
                          safeStatusUpdate(statusMessageId, textValue),
                      );
                      await safeStatusUpdate(
                        statusMessageId,
                        buildStatusCard("✅ [cache] Proses selesai", [
                          {
                            label: "Markdown (terkirim/gagal)",
                            value: `${markdownStats.sent}/${markdownStats.failed}`,
                          },
                          {
                            label: "Text (terkirim/gagal)",
                            value: `${textStats.sent}/${textStats.failed}`,
                          },
                        ]),
                      );
                      return;
                    }
                    extractCache.delete(cacheKey);
                  }

                  if (cancelToken.isCancelled()) {
                    await safeStatusUpdate(
                      statusMessageId,
                      "🛑 Job extract dibatalkan sebelum proses crawl.",
                    );
                    return;
                  }

                  await logger.info("extract started", {
                    chatId,
                    url: command.url,
                    maxPages: command.maxPages,
                  });

                  let extraction;
                  try {
                    extraction = await runExtraction(
                      {
                        rootUrl: command.url,
                        maxPages: command.maxPages,
                        outputRoot: config.outputRoot,
                      },
                      {
                        includePagesInResponse: false,
                        shouldCancel: () => cancelToken.isCancelled(),
                        signal: timedCancel.signal,
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
                  } catch (error) {
                    if (cancelToken.isCancelled()) {
                      await safeStatusUpdate(
                        statusMessageId,
                        "🛑 Job extract dibatalkan.",
                      );
                      return;
                    }
                    if (timedCancel.didTimeout()) {
                      await safeStatusUpdate(
                        statusMessageId,
                        buildStatusCard("⏱️ Job extract dihentikan (timeout)", [
                          {
                            label: "Batas waktu",
                            value: `${Math.round(extractTimeoutMs / 1000)}s`,
                          },
                          {
                            label: "Aksi",
                            value:
                              "Coba /stop lalu ulangi dengan maxPages lebih kecil.",
                          },
                        ]),
                      );
                      await logger.warn("extract timeout", {
                        chatId,
                        url: command.url,
                        maxPages: command.maxPages,
                        timeoutMs: extractTimeoutMs,
                      });
                      return;
                    }
                    throw error;
                  }

                  if (cancelToken.isCancelled()) {
                    await safeStatusUpdate(
                      statusMessageId,
                      "🛑 Job extract dibatalkan setelah crawl.",
                    );
                    return;
                  }

                  extractCache.set(cacheKey, {
                    key: cacheKey,
                    rootUrl: command.url,
                    maxPages: command.maxPages,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + extractCacheTtlMs,
                    extraction: {
                      runId: extraction.runId,
                      site: extraction.site,
                      resultFile: extraction.resultFile,
                      markdownFiles: extraction.markdownFiles,
                      textFiles: extraction.textFiles,
                      crawledPages: extraction.result.crawledPages,
                    },
                  });
                  cleanupExtractCache(extractCache, extractCacheMaxEntries);

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
                      {
                        label: "File text",
                        value: extraction.textFiles.length,
                      },
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
                      error:
                        error instanceof Error ? error.message : String(error),
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
                    extraction.textFiles.length > 0 &&
                    !cancelToken.isCancelled()
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
                      (textValue) =>
                        safeStatusUpdate(statusMessageId, textValue),
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
                } finally {
                  timedCancel.cleanup();
                  clearInterval(heartbeat);
                }
              },
            );

            if (queuedExtractJob.position < 0) {
              await api.sendMessage(
                chatId,
                "Antrian extract penuh. Coba lagi beberapa saat.",
              );
              continue;
            }

            if (!queuedExtractJob.started) {
              await api.sendMessage(
                chatId,
                `⏳ Job extract masuk antrian #${queuedExtractJob.position}.`,
              );
            }
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
      if (isTimeoutLikeError(error)) {
        consecutivePollingTimeouts += 1;
        const backoffMs = pollingTimeoutBackoffMs(consecutivePollingTimeouts);
        if (shouldLogPollingTimeout(consecutivePollingTimeouts)) {
          await logger.warn("polling timeout", {
            consecutiveTimeouts: consecutivePollingTimeouts,
            backoffMs,
          });
        }
        await Bun.sleep(backoffMs);
        continue;
      }

      consecutivePollingTimeouts = 0;
      await logger.error("polling loop error", error);
      await Bun.sleep(2000);
    }
  }
}
