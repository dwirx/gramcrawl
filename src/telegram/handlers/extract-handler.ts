import type { BotContext } from "../context";
import { buildStatusCard } from "../ui/formatter";
import { runExtraction } from "../../app/extract-service";
import { buildExtractCacheKey, resolveExtractJobTimeoutMs } from "./extract";
import { createTimedAbortSignal } from "../runtime-utils";
import { buildSendFileName } from "./subtitle-utils";
import type { BrowserEngine } from "../../extractor/types";
import type { TelegramCommand } from "../command-parser";

export async function handleExtractCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { url: string }>,
): Promise<void> {
  const maxPages = (command as any).maxPages ?? 1;

  const queuedExtractJob = ctx.queue.enqueueChatJob(
    chatId,
    `${command.kind}:${command.url}`,
    async (cancelToken) => {
      const cacheKey = buildExtractCacheKey(command.url, maxPages);
      const extractTimeoutMs = resolveExtractJobTimeoutMs(maxPages);
      const timedCancel = createTimedAbortSignal(
        extractTimeoutMs,
        cancelToken.signal,
      );
      let lastStatusAt = 0;
      let heartbeatBusy = false;

      const isLightpandaCmd = command.kind === "lightpanda";
      const isForceCmd = command.kind === "force" || command.kind === "full";

      const browserEngine: BrowserEngine | undefined = isLightpandaCmd
        ? "lightpanda"
        : undefined;

      const prevForce = process.env.EXTRACT_BROWSER_FORCE;
      const prevFallback = process.env.EXTRACT_BROWSER_FALLBACK;

      if (isForceCmd || isLightpandaCmd) {
        process.env.EXTRACT_BROWSER_FORCE = "1";
        process.env.EXTRACT_BROWSER_FALLBACK = "1";
      }

      const restoreEnv = (): void => {
        if (isForceCmd || isLightpandaCmd) {
          if (prevForce === undefined) {
            delete process.env.EXTRACT_BROWSER_FORCE;
          } else {
            process.env.EXTRACT_BROWSER_FORCE = prevForce;
          }

          if (prevFallback === undefined) {
            delete process.env.EXTRACT_BROWSER_FALLBACK;
          } else {
            process.env.EXTRACT_BROWSER_FALLBACK = prevFallback;
          }
        }
      };

      const safeStatusUpdate = async (
        api: any,
        targetChatId: number,
        messageId: number,
        text: string,
      ) => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        try {
          await api.editMessage(targetChatId, messageId, text);
        } catch {
          // ignore
        } finally {
          heartbeatBusy = false;
        }
      };

      await ctx.api.sendChatAction(chatId, "typing");
      const statusMessageId = await ctx.api.sendMessage(
        chatId,
        buildStatusCard(`⏳ [1/3] Memulai ${command.kind}`, [
          { label: "URL", value: command.url },
          { label: "Max pages", value: maxPages },
        ]),
      );

      try {
        const cached = ctx.cache.get(cacheKey);
        if (cached && command.kind === "extract") {
          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            buildStatusCard("✅ [2/3] Menggunakan cache", [
              { label: "Run ID", value: cached.extraction.runId },
              { label: "Halaman", value: cached.extraction.crawledPages },
            ]),
          );

          await ctx.api.sendChatAction(chatId, "upload_document");
          await ctx.api.sendDocument(
            chatId,
            cached.extraction.resultFile,
            "Hasil extraction (JSON)",
            buildSendFileName(cached.extraction.resultFile, "result"),
          );

          if (cached.extraction.markdownFiles.length > 0) {
            const mdPath = cached.extraction.markdownFiles[0];
            if (mdPath) {
              await ctx.api.sendChatAction(chatId, "upload_document");
              await ctx.api.sendDocument(
                chatId,
                mdPath,
                "Markdown Preview",
                buildSendFileName(mdPath, "preview"),
              );
            }
          }

          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            buildStatusCard(`✅ [3/3] ${command.kind} selesai (Cache)`, [
              { label: "Run ID", value: cached.extraction.runId },
              { label: "Output", value: cached.extraction.resultFile },
            ]),
          );
          restoreEnv();
          return;
        }

        const extraction = await runExtraction(
          {
            rootUrl: command.url,
            maxPages,
            outputRoot: ctx.config.outputRoot,
          },
          {
            browserEngine,
            signal: timedCancel.signal,
            onProgress: async (progress) => {
              const now = Date.now();
              if (now - lastStatusAt > 3500) {
                lastStatusAt = now;
                await safeStatusUpdate(
                  ctx.api,
                  chatId,
                  statusMessageId,
                  buildStatusCard(`⏳ [2/3] Memproses ${command.kind}`, [
                    { label: "Status", value: progress.message },
                  ]),
                );
              }
            },
          },
        );

        if (timedCancel.signal.aborted) {
          await ctx.api.editMessage(
            chatId,
            statusMessageId,
            buildStatusCard(`🛑 ${command.kind} dibatalkan/timeout`, [
              { label: "URL", value: command.url },
              {
                label: "Detail",
                value: timedCancel.didTimeout() ? "Timeout" : "Dibatalkan",
              },
            ]),
          );
          restoreEnv();
          return;
        }

        if (command.kind === "extract") {
          ctx.cache.set(cacheKey, {
            key: cacheKey,
            rootUrl: command.url,
            maxPages,
            createdAt: Date.now(),
            expiresAt: Date.now() + 3600000,
            extraction: {
              runId: extraction.runId,
              site: extraction.site,
              resultFile: extraction.resultFile,
              markdownFiles: extraction.markdownFiles,
              textFiles: extraction.textFiles,
              crawledPages: extraction.result.pages.length,
            },
          });
        }

        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard(`✅ [2/3] ${command.kind} berhasil`, [
            { label: "Run ID", value: extraction.runId },
            { label: "Halaman", value: extraction.result.pages.length },
          ]),
        );

        await ctx.api.sendChatAction(chatId, "upload_document");
        await ctx.api.sendDocument(
          chatId,
          extraction.resultFile,
          "Hasil extraction (JSON)",
          buildSendFileName(extraction.resultFile, "result"),
        );

        if (extraction.markdownFiles.length > 0) {
          const mdPath = extraction.markdownFiles[0];
          if (mdPath) {
            await ctx.api.sendChatAction(chatId, "upload_document");
            await ctx.api.sendDocument(
              chatId,
              mdPath,
              "Markdown Preview",
              buildSendFileName(mdPath, "preview"),
            );
          }
        }

        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard(`✅ [3/3] ${command.kind} selesai`, [
            { label: "Run ID", value: extraction.runId },
            { label: "Output", value: extraction.resultFile },
          ]),
        );

        await ctx.logger.info("extraction completed", {
          chatId,
          url: command.url,
          runId: extraction.runId,
          pages: extraction.result.pages.length,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await ctx.api.editMessage(
          chatId,
          statusMessageId,
          buildStatusCard(`❌ ${command.kind} gagal`, [
            { label: "Detail", value: detail.slice(0, 350) },
          ]),
        );
        await ctx.logger.error("extraction failed", error, {
          chatId,
          url: command.url,
        });
      } finally {
        timedCancel.cleanup();
        restoreEnv();
      }
    },
  );

  if (queuedExtractJob.position < 0) {
    await ctx.api.sendMessage(chatId, `Antrian ${command.kind} penuh.`);
    return;
  }

  if (!queuedExtractJob.started) {
    await ctx.api.sendMessage(
      chatId,
      `⏳ Job ${command.kind} masuk antrian #${queuedExtractJob.position}.`,
    );
  }
}
