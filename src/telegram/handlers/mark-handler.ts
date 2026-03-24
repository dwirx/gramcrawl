import type { BotContext } from "../context";
import { buildStatusCard } from "../ui/formatter";
import { extractWithMarkdownNew } from "../../mark/service";
import { buildSendFileName } from "./subtitle-utils";
import type { TelegramCommand } from "../command-parser";

export async function handleMarkCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "mark" }>,
): Promise<void> {
  const queuedMarkJob = ctx.queue.enqueueChatJob(
    chatId,
    `mark:${command.url}`,
    async (cancelToken) => {
      await ctx.api.sendChatAction(chatId, "typing");
      const statusMessageId = await ctx.api.sendMessage(
        chatId,
        buildStatusCard("⏳ [1/3] Memproses /mark", [
          { label: "URL", value: command.url },
        ]),
      );

      try {
        const marked = await extractWithMarkdownNew(
          command.url,
          ctx.config.outputRoot,
        );

        if (cancelToken.isCancelled()) {
          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            "🛑 Job /mark dibatalkan.",
          );
          return;
        }

        await ctx.api.editMessage(
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

        await ctx.api.sendChatAction(chatId, "upload_document");
        await ctx.api.sendDocument(
          chatId,
          marked.markdownPath,
          "Markdown (.md)",
          buildSendFileName(marked.markdownPath, marked.title),
        );
        await ctx.api.sendChatAction(chatId, "upload_document");
        await ctx.api.sendDocument(
          chatId,
          marked.textPath,
          "Markdown mirror (.txt)",
          buildSendFileName(marked.textPath, marked.title),
        );

        await ctx.api.editMessage(
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

        await ctx.logger.info("mark completed", {
          chatId,
          url: command.url,
          title: marked.title,
          method: marked.method,
          tokens: marked.tokens,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard("❌ /mark gagal", [
            { label: "Detail", value: detail.slice(0, 350) },
          ]),
        );
        await ctx.logger.error("mark failed", error, {
          chatId,
          url: command.url,
        });
      }
    },
  );

  if (queuedMarkJob.position < 0) {
    await ctx.api.sendMessage(chatId, "Antrian /mark penuh. Coba lagi.");
    return;
  }

  if (!queuedMarkJob.started) {
    await ctx.api.sendMessage(
      chatId,
      `⏳ Job /mark masuk antrian #${queuedMarkJob.position}.`,
    );
  }
}
