import type { BotContext } from "../context";
import { buildStatusCard } from "../ui/formatter";
import { extractWithDefuddle } from "../../mark/service";
import { buildSendFileName } from "./subtitle-utils";
import type { TelegramCommand } from "../command-parser";

export async function handleDefuddleCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "defuddle" }>,
): Promise<void> {
  const queuedDefuddleJob = ctx.queue.enqueueChatJob(
    chatId,
    `defuddle:${command.url}`,
    async (cancelToken) => {
      await ctx.api.sendChatAction(chatId, "typing");
      const statusMessageId = await ctx.api.sendMessage(
        chatId,
        buildStatusCard("⏳ [1/3] Memproses /defuddle", [
          { label: "URL", value: command.url },
        ]),
      );

      try {
        const extracted = await extractWithDefuddle(
          command.url,
          ctx.config.outputRoot,
        );

        if (cancelToken.isCancelled()) {
          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            "🛑 Job /defuddle dibatalkan.",
          );
          return;
        }

        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard("✅ [2/3] Defuddle berhasil dibuat", [
            { label: "Title", value: extracted.title },
            { label: "Method", value: extracted.method },
          ]),
        );

        await ctx.api.sendChatAction(chatId, "upload_document");
        await ctx.api.sendDocument(
          chatId,
          extracted.markdownPath,
          "Defuddle markdown (.md)",
          buildSendFileName(extracted.markdownPath, extracted.title),
        );
        await ctx.api.sendChatAction(chatId, "upload_document");
        await ctx.api.sendDocument(
          chatId,
          extracted.textPath,
          "Defuddle mirror (.txt)",
          buildSendFileName(extracted.textPath, extracted.title),
        );

        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard("✅ [3/3] /defuddle selesai", [
            { label: "Output", value: extracted.outputDir },
            {
              label: "File",
              value: [
                buildSendFileName(extracted.markdownPath, extracted.title),
                buildSendFileName(extracted.textPath, extracted.title),
              ].join(" + "),
            },
          ]),
        );

        await ctx.logger.info("defuddle completed", {
          chatId,
          url: command.url,
          title: extracted.title,
          method: extracted.method,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard("❌ /defuddle gagal", [
            { label: "Detail", value: detail.slice(0, 350) },
          ]),
        );
        await ctx.logger.error("defuddle failed", error, {
          chatId,
          url: command.url,
        });
      }
    },
  );

  if (queuedDefuddleJob.position < 0) {
    await ctx.api.sendMessage(chatId, "Antrian /defuddle penuh. Coba lagi.");
    return;
  }

  if (!queuedDefuddleJob.started) {
    await ctx.api.sendMessage(
      chatId,
      `⏳ Job /defuddle masuk antrian #${queuedDefuddleJob.position}.`,
    );
  }
}
