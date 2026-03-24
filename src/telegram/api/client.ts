import {
  TELEGRAM_MAX_RETRIES,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  TELEGRAM_REQUEST_TIMEOUT_MS,
} from "./constants";
import type {
  TelegramApiResponse,
  TelegramChatAction,
  TelegramFile,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
  TelegramBotCommand,
} from "./types";

export class TelegramApi {
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
