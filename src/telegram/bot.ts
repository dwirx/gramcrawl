import { z } from "zod";
import { runExtraction } from "../app/extract-service";
import { readManifest } from "../app/run-store";
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
  };
};

type TelegramMessage = {
  message_id: number;
};

type TelegramChatAction = "typing" | "upload_document";

const BotConfigSchema = z.object({
  token: z.string().min(10),
  outputRoot: z.string().default("output"),
});

type BotConfig = z.infer<typeof BotConfigSchema>;

class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 30,
        limit: 20,
        allowed_updates: ["message"],
      }),
    });

    const payload = (await response.json()) as TelegramApiResponse<
      TelegramUpdate[]
    >;

    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram getUpdates error");
    }

    return payload.result;
  }

  async sendMessage(chatId: number, text: string): Promise<number> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    const payload =
      (await response.json()) as TelegramApiResponse<TelegramMessage>;

    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram sendMessage error");
    }

    return payload.result.message_id;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const payload = (await response.json()) as TelegramApiResponse<unknown>;

    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram editMessageText error");
    }
  }

  async sendDocument(
    chatId: number,
    path: string,
    caption?: string,
  ): Promise<void> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File tidak ditemukan: ${path}`);
    }

    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", file, path.split("/").at(-1) ?? "document");
    if (caption) {
      form.set("caption", caption);
    }

    const response = await fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const payload = (await response.json()) as TelegramApiResponse<unknown>;

    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram sendDocument error");
    }
  }

  async sendChatAction(
    chatId: number,
    action: TelegramChatAction,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });
    const payload = (await response.json()) as TelegramApiResponse<unknown>;

    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram sendChatAction error");
    }
  }
}

function buildHelpMessage(): string {
  return [
    "Perintah bot:",
    "/extract <url> [maxPages] - ekstrak website ke JSON + Markdown",
    "/runs [limit] - lihat riwayat extract",
    "/help - bantuan",
    "",
    "Anda juga bisa kirim URL langsung tanpa command.",
  ].join("\n");
}

async function sendFilesBatch(
  api: TelegramApi,
  chatId: number,
  title: string,
  files: string[],
): Promise<void> {
  const limitedFiles = files.slice(0, 5);

  for (let index = 0; index < limitedFiles.length; index += 1) {
    const path = limitedFiles[index];
    if (!path) {
      continue;
    }
    await api.sendDocument(
      chatId,
      path,
      `${title} ${index + 1}/${limitedFiles.length}`,
    );
  }

  if (files.length > limitedFiles.length) {
    await api.sendMessage(
      chatId,
      `File ${title.toLowerCase()} terlalu banyak (${files.length}). Dikirim ${limitedFiles.length} file pertama.`,
    );
  }
}

export async function startTelegramBot(configInput: BotConfig): Promise<void> {
  const config = BotConfigSchema.parse(configInput);
  const api = new TelegramApi(config.token);
  const logger = createLogger("telegram-bot");
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

          const chatId = update.message?.chat.id;
          const text = update.message?.text?.trim();

          if (!chatId || !text) {
            continue;
          }

          await logger.info("message received", { chatId, text });
          const command = parseTelegramCommand(text);

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

          if (command.kind === "extract") {
            await api.sendChatAction(chatId, "typing");
            const statusMessageId = await api.sendMessage(
              chatId,
              `⏳ [1/5] Memulai extract\nURL: ${command.url}\nmaxPages=${command.maxPages}`,
            );
            await logger.info("extract started", {
              chatId,
              url: command.url,
              maxPages: command.maxPages,
            });

            const extraction = await runExtraction(
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
                  await logger.info("extract progress", {
                    chatId,
                    url: command.url,
                    step: progress.step,
                    detail: progress.message,
                  });

                  try {
                    await api.sendChatAction(chatId, "typing");
                    await api.editMessage(chatId, statusMessageId, statusText);
                  } catch {
                    // fallback kalau message tidak bisa diedit (mis. race condition)
                    await api.sendMessage(chatId, statusText);
                  }
                },
              },
            );

            await api.editMessage(
              chatId,
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

            await api.sendDocument(
              chatId,
              extraction.resultFile,
              "Result JSON",
            );
            await api.sendChatAction(chatId, "upload_document");
            await sendFilesBatch(
              api,
              chatId,
              "Markdown",
              extraction.markdownFiles,
            );
            await sendFilesBatch(api, chatId, "Text", extraction.textFiles);
            await api.editMessage(
              chatId,
              statusMessageId,
              "✅ Semua file berhasil dikirim.",
            );
            await logger.info("extract completed", {
              chatId,
              runId: extraction.runId,
              site: extraction.site,
              crawledPages: extraction.result.crawledPages,
            });
            continue;
          }

          await api.sendMessage(chatId, buildHelpMessage());
          await logger.warn("unknown command", { chatId, text });
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
