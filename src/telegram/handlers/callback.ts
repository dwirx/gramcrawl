import type { TelegramUpdate } from "../api/types";
import type { BotContext } from "../context";
import { parseMainMenuCallbackData, parseSubtitleCallbackData } from "./parser";
import {
  buildHelpMessage,
  buildMenuActionMessage,
  buildRunsMessage,
  buildSettingsStatusMessage,
} from "../ui/message";
import { buildMainMenuKeyboard } from "../ui/keyboard";
import { readManifest } from "../../app/run-store";
import { buildStatusCard } from "../ui/formatter";
import { downloadSubtitlesAndConvert } from "../../subtitle/service";
import {
  sendSubtitleFiles,
  isSubtitleTimestampEnabled,
} from "./subtitle-utils";

export async function handleCallbackQuery(
  ctx: BotContext,
  callback: Exclude<TelegramUpdate["callback_query"], undefined>,
): Promise<void> {
  const menuAction = parseMainMenuCallbackData(callback.data);
  if (menuAction) {
    const callbackChatId = callback.message?.chat.id;
    if (!callbackChatId) {
      await ctx.api.answerCallbackQuery(callback.id, "Chat tidak tersedia.");
      return;
    }

    await ctx.api.answerCallbackQuery(callback.id, "Diproses...");
    if (menuAction === "help") {
      await ctx.api.sendMessage(
        callbackChatId,
        buildHelpMessage(),
        buildMainMenuKeyboard(),
      );
    } else if (menuAction === "runs") {
      const runs = await readManifest(ctx.config.outputRoot);
      await ctx.api.sendMessage(callbackChatId, buildRunsMessage(runs, 5));
    } else if (menuAction === "settings") {
      await ctx.api.sendMessage(callbackChatId, buildSettingsStatusMessage());
    } else {
      await ctx.api.sendMessage(
        callbackChatId,
        buildMenuActionMessage(menuAction),
        buildMainMenuKeyboard(),
      );
    }
    return;
  }

  const callbackData = parseSubtitleCallbackData(callback.data);
  if (!callbackData) {
    await ctx.api.answerCallbackQuery(callback.id, "Aksi tidak dikenal.");
    return;
  }

  const callbackChatId = callback.message?.chat.id;
  if (!callbackChatId) {
    await ctx.api.answerCallbackQuery(callback.id, "Chat tidak tersedia.");
    return;
  }

  const session = ctx.sessions.get(callbackData.sessionId);
  if (!session || session.chatId !== callbackChatId) {
    await ctx.api.answerCallbackQuery(
      callback.id,
      "Sesi subtitle sudah expired. Jalankan /subtitle lagi.",
    );
    return;
  }

  if (!session.languages.has(callbackData.language)) {
    if (callbackData.language !== "__auto__") {
      await ctx.api.answerCallbackQuery(callback.id, "Bahasa tidak valid.");
      return;
    }
  }

  const selectedLanguage =
    callbackData.language === "__auto__"
      ? session.bestLanguage
      : callbackData.language;

  if (!selectedLanguage || !session.languages.has(selectedLanguage)) {
    await ctx.api.answerCallbackQuery(
      callback.id,
      "Auto subtitle tidak tersedia. Jalankan /subtitle lagi.",
    );
    return;
  }

  const callbackUserId = callback.from?.id ?? callbackChatId;
  const callbackRateLimit = ctx.rateLimit.consume(callbackUserId);
  if (!callbackRateLimit.allowed) {
    await ctx.api.answerCallbackQuery(
      callback.id,
      `Terlalu sering. Coba lagi ${callbackRateLimit.retryAfterSec}s.`,
    );
    return;
  }

  ctx.sessions.delete(callbackData.sessionId);
  const queuedSubtitleJob = ctx.queue.enqueueChatJob(
    callbackChatId,
    `subtitle:${selectedLanguage}`,
    async (cancelToken) => {
      await ctx.logger.info("subtitle callback selected", {
        chatId: callbackChatId,
        requestedLanguage: callbackData.language,
        language: selectedLanguage,
        title: session.title,
      });

      if (cancelToken.isCancelled()) {
        await ctx.api.sendMessage(
          callbackChatId,
          "Job subtitle dibatalkan sebelum diproses.",
        );
        return;
      }

      const statusMessageId = await ctx.api.sendMessage(
        callbackChatId,
        buildStatusCard("⏳ [1/4] Menyiapkan subtitle", [
          { label: "URL", value: session.url },
          { label: "Bahasa", value: selectedLanguage },
        ]),
      );

      try {
        await ctx.api.editMessage(
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
          ctx.config.outputRoot,
          { includeTimestamp: isSubtitleTimestampEnabled() },
        );

        if (cancelToken.isCancelled()) {
          await ctx.api.editMessage(
            callbackChatId,
            statusMessageId,
            buildStatusCard("🛑 Subtitle dibatalkan", [
              { label: "Judul", value: subtitleResult.title },
              { label: "Bahasa", value: subtitleResult.language },
            ]),
          );
          return;
        }

        await ctx.api.editMessage(
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

        const sent = await sendSubtitleFiles(ctx.api, callbackChatId, [
          subtitleResult.srtPath,
          subtitleResult.vttPath,
          subtitleResult.txtPath,
          subtitleResult.mdPath,
        ]);

        await ctx.api.editMessage(
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
        await ctx.logger.info("subtitle completed", {
          chatId: callbackChatId,
          title: subtitleResult.title,
          language: subtitleResult.language,
          sent: sent.sent,
          failed: sent.failed,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        await ctx.api.editMessage(
          callbackChatId,
          statusMessageId,
          buildStatusCard("❌ Subtitle gagal diproses", [
            { label: "Detail", value: errorMessage.slice(0, 350) },
          ]),
        );
        await ctx.logger.error("subtitle callback failed", error, {
          chatId: callbackChatId,
          requestedLanguage: callbackData.language,
          language: selectedLanguage,
          url: session.url,
        });
      }
    },
  );

  if (queuedSubtitleJob.position < 0) {
    await ctx.api.answerCallbackQuery(callback.id, "Antrian penuh.");
    await ctx.api.sendMessage(
      callbackChatId,
      "Antrian sedang penuh. Coba lagi beberapa saat.",
    );
    return;
  }

  if (queuedSubtitleJob.started) {
    await ctx.api.answerCallbackQuery(
      callback.id,
      `Memproses subtitle ${selectedLanguage}...`,
    );
  } else {
    await ctx.api.answerCallbackQuery(
      callback.id,
      `Masuk antrian #${queuedSubtitleJob.position}`,
    );
    await ctx.api.sendMessage(
      callbackChatId,
      `⏳ Job subtitle masuk antrian #${queuedSubtitleJob.position}.`,
    );
  }
}
