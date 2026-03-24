import type { BotContext } from "../context";
import { buildStatusCard } from "../ui/formatter";
import {
  listAvailableSubtitles,
  resolveOriginalLanguage,
  pickPreferredSubtitleLanguages,
  pickBestSubtitleLanguage,
} from "../../subtitle/service";
import { buildSubtitleKeyboard } from "../ui/keyboard";
import {
  renderSubtitleLanguageList,
  renderAllYoutubeLanguages,
  isSubtitleTimestampEnabled,
  writeSubtitleTimestampToEnv,
} from "./subtitle-utils";
import { modeLabel, modeEnvValue } from "../ui/formatter";
import type { TelegramCommand } from "../command-parser";

export async function handleSubtitleCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "subtitle" }>,
): Promise<void> {
  const queuedSubtitleListJob = ctx.queue.enqueueChatJob(
    chatId,
    `subtitle:list:${command.url}`,
    async (cancelToken) => {
      await ctx.api.sendChatAction(chatId, "typing");
      const statusMessageId = await ctx.api.sendMessage(
        chatId,
        buildStatusCard("⏳ [1/2] Mengecek subtitle", [
          { label: "URL", value: command.url },
        ]),
      );

      try {
        if (cancelToken.isCancelled()) {
          await ctx.api.editMessage(
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
          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            buildStatusCard("❌ Subtitle tidak tersedia", [
              { label: "Judul", value: listed.title },
              { label: "URL", value: listed.webpageUrl },
            ]),
          );
          return;
        }

        const sessionId = ctx.sessions.createId();
        ctx.sessions.set(sessionId, {
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

        const keyboard = buildSubtitleKeyboard(
          sessionId,
          preferred.map((p) => p.code),
          bestLanguage?.code ?? null,
        );
        await ctx.api.editMessage(
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
        await ctx.api.sendMessage(chatId, "Pilih bahasa subtitle:", keyboard);

        await ctx.logger.info("subtitle listed", {
          chatId,
          title: listed.title,
          url: listed.webpageUrl,
          languages: listed.languages.length,
          bestLanguage: bestLanguage?.code ?? null,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard("❌ Gagal mengecek subtitle", [
            { label: "URL", value: command.url },
            { label: "Detail", value: detail.slice(0, 350) },
          ]),
        );
        await ctx.logger.error("subtitle list failed", error, {
          chatId,
          url: command.url,
        });
      }
    },
  );

  if (queuedSubtitleListJob.position < 0) {
    await ctx.api.sendMessage(
      chatId,
      "Antrian subtitle penuh. Coba lagi beberapa saat.",
    );
    return;
  }

  if (!queuedSubtitleListJob.started) {
    await ctx.api.sendMessage(
      chatId,
      `⏳ Job subtitle masuk antrian #${queuedSubtitleListJob.position}.`,
    );
  }
}

export async function handleSubtitleTimestampCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "subtitleTimestamp" }>,
): Promise<void> {
  if (command.action === "status") {
    const enabled = isSubtitleTimestampEnabled();
    await ctx.api.sendMessage(
      chatId,
      [
        "Status subtitle timestamp:",
        `• Mode: ${modeLabel(enabled)}`,
        `• EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(enabled)}`,
      ].join("\n"),
    );
    return;
  }

  const enabled = command.action === "on";
  await writeSubtitleTimestampToEnv(ctx.config.envPath, enabled);
  await ctx.api.sendMessage(
    chatId,
    [
      `Subtitle timestamp berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
      `Mode sekarang: ${modeLabel(enabled)}`,
      `EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(enabled)}`,
      `Disimpan di ${ctx.config.envPath} dan langsung aktif di proses bot ini.`,
    ].join("\n"),
  );
  await ctx.logger.info("subtitle timestamp mode changed", {
    chatId,
    action: command.action,
    envPath: ctx.config.envPath,
  });
}
