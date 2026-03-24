import { rm } from "node:fs/promises";
import type { TelegramUpdate } from "../api/types";
import type { BotContext } from "../context";
import { parseTelegramCommand, type TelegramCommand } from "../command-parser";
import { autoImportCookieDocument } from "./document-utils";
import {
  buildWelcomeMenuMessage,
  buildHelpMessage,
  buildRunsMessage,
  buildUnknownCommandMessage,
} from "../ui/message";
import { buildStatusCard } from "../ui/formatter";
import { buildMainMenuKeyboard } from "../ui/keyboard";
import {
  BOT_RESTART_EXIT_DELAY_MS,
  CLEAN_CHAT_SCAN_MULTIPLIER,
} from "../constants";
import { readManifest, writeManifest } from "../../app/run-store";
import { parseSiteScope, removeDirectoriesByName } from "./extract";

export function isCommandRateLimited(command: TelegramCommand): boolean {
  if (
    command.kind === "help" ||
    command.kind === "cancel" ||
    command.kind === "stats"
  ) {
    return false;
  }
  return true;
}

export async function handleMessage(
  ctx: BotContext,
  message: Exclude<TelegramUpdate["message"], undefined>,
): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  const caption = message.caption?.trim();
  const commandInput = text || caption || "";
  const document = message.document;

  if (document && !commandInput) {
    await ctx.logger.info("document received", {
      chatId,
      fileName: document.file_name ?? "unknown",
    });
    const imported = await autoImportCookieDocument(
      ctx.api,
      ctx.logger,
      chatId,
      document,
      ctx.config.envPath,
    );
    if (imported) {
      return;
    }
  }

  if (!commandInput) {
    return;
  }

  await ctx.logger.info("message received", { chatId, text: commandInput });
  const command = parseTelegramCommand(commandInput);
  const commandRoot = commandInput.split(/\s+/)[0]?.toLowerCase() ?? "";
  const userId = message.from?.id ?? chatId;

  if (isCommandRateLimited(command)) {
    const commandRateLimit = ctx.rateLimit.consume(userId);
    if (!commandRateLimit.allowed) {
      await ctx.api.sendMessage(
        chatId,
        `Terlalu banyak request. Coba lagi dalam ${commandRateLimit.retryAfterSec} detik.`,
      );
      return;
    }
  }

  if (command.kind === "help") {
    if (commandRoot === "/start" || commandRoot === "/menu") {
      await ctx.api.sendMessage(
        chatId,
        buildWelcomeMenuMessage(),
        buildMainMenuKeyboard(),
      );
      return;
    }
    await ctx.api.sendMessage(
      chatId,
      buildHelpMessage(),
      buildMainMenuKeyboard(),
    );
    return;
  }

  if (command.kind === "cancel") {
    const cancelled = ctx.queue.cancelChatJobs(chatId);
    await ctx.api.sendMessage(
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
    return;
  }

  if (command.kind === "restart") {
    const cancelled = ctx.queue.cancelChatJobs(chatId);
    await ctx.api.sendMessage(
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
    await ctx.logger.warn("restart requested from telegram", {
      chatId,
      runningCancelled: cancelled.runningCancelled,
      queuedCleared: cancelled.queuedCleared,
    });
    setTimeout(() => {
      process.exit(0);
    }, BOT_RESTART_EXIT_DELAY_MS);
    return;
  }

  if (command.kind === "stats") {
    ctx.cache.cleanup();
    ctx.sessions.cleanup();
    const queue = ctx.queue.getStats();
    const memory = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - ctx.botStartedAt) / 1000);
    await ctx.api.sendMessage(
      chatId,
      buildStatusCard("Bot runtime stats", [
        { label: "Uptime", value: `${uptimeSec}s` },
        { label: "Queue chat aktif", value: queue.activeChats },
        { label: "Queue running", value: queue.runningJobs },
        { label: "Queue menunggu", value: queue.queuedJobs },
        { label: "Extract cache", value: ctx.cache.size() },
        { label: "Subtitle session", value: ctx.sessions.size() },
        { label: "Rate buckets", value: ctx.rateLimit.size() },
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
    return;
  }

  if (command.kind === "clearCache") {
    const cleared = {
      extractCacheCount: ctx.cache.size(),
      subtitleSessionCount: ctx.sessions.size(),
      rateLimitCount: ctx.rateLimit.size(),
    };
    ctx.cache.clear();
    ctx.sessions.clear();
    ctx.rateLimit.clear();

    await ctx.api.sendMessage(
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
    return;
  }

  if (command.kind === "cleanOutput") {
    if (command.scope === "all") {
      await rm(`${ctx.config.outputRoot}/sites`, {
        recursive: true,
        force: true,
      });
      await rm(`${ctx.config.outputRoot}/runs-manifest.json`, {
        force: true,
      });
      ctx.cache.clear();
      await ctx.api.sendMessage(
        chatId,
        "Output berhasil dibersihkan untuk semua site.",
      );
      return;
    }

    const site = parseSiteScope(command.site);
    if (!site) {
      await ctx.api.sendMessage(
        chatId,
        "Format site tidak valid. Gunakan /cleanoutput <all|site>.",
      );
      return;
    }

    await rm(`${ctx.config.outputRoot}/sites/${site}`, {
      recursive: true,
      force: true,
    });

    const runs = await readManifest(ctx.config.outputRoot);
    const filtered = runs.filter((item) => item.site !== site);
    await writeManifest(ctx.config.outputRoot, filtered);
    ctx.cache.clearBySite(site);

    await ctx.api.sendMessage(chatId, `Output site ${site} berhasil dihapus.`);
    return;
  }

  if (command.kind === "cleanDownloads") {
    const site = parseSiteScope(command.site);
    const root =
      command.scope === "all"
        ? `${ctx.config.outputRoot}/sites`
        : `${ctx.config.outputRoot}/sites/${site}`;

    if (command.scope === "site" && !site) {
      await ctx.api.sendMessage(
        chatId,
        "Format site tidak valid. Gunakan /cleandownloads <all|site>.",
      );
      return;
    }

    const removedDirs = await removeDirectoriesByName(root, "subtitles");
    await ctx.api.sendMessage(
      chatId,
      `Cleanup download selesai. Folder subtitles terhapus: ${removedDirs}.`,
    );
    return;
  }

  if (command.kind === "clearChat") {
    const anchorId = message.message_id;
    if (!anchorId) {
      await ctx.api.sendMessage(chatId, "Message anchor tidak tersedia.");
      return;
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

      const ok = await ctx.api.deleteMessage(chatId, targetMessageId);
      if (ok) {
        deleted += 1;
      }
    }

    await ctx.api.sendMessage(
      chatId,
      `Clear chat selesai. Message terhapus: ${deleted}/${command.limit}.`,
    );
    return;
  }

  if (command.kind === "runs") {
    const runs = await readManifest(ctx.config.outputRoot);
    await ctx.api.sendMessage(chatId, buildRunsMessage(runs, command.limit));
    await ctx.logger.info("runs sent", {
      chatId,
      count: Math.min(runs.length, command.limit),
    });
    return;
  }

  if (
    command.kind === "extract" ||
    command.kind === "force" ||
    command.kind === "full" ||
    command.kind === "lightpanda"
  ) {
    const { handleExtractCommand } = await import("./extract-handler");
    return handleExtractCommand(ctx, chatId, command);
  }

  if (command.kind === "subtitle") {
    const { handleSubtitleCommand } = await import("./subtitle-handler");
    return handleSubtitleCommand(ctx, chatId, command);
  }

  if (command.kind === "subtitleTimestamp") {
    const { handleSubtitleTimestampCommand } =
      await import("./subtitle-handler");
    return handleSubtitleTimestampCommand(ctx, chatId, command);
  }

  if (command.kind === "mark") {
    const { handleMarkCommand } = await import("./mark-handler");
    return handleMarkCommand(ctx, chatId, command);
  }

  if (command.kind === "defuddle") {
    const { handleDefuddleCommand } = await import("./defuddle-handler");
    return handleDefuddleCommand(ctx, chatId, command);
  }

  if (command.kind === "ytDlp") {
    const { handleYtDlpCommand } = await import("./ytdlp-handler");
    return handleYtDlpCommand(ctx, chatId, command);
  }

  if (command.kind === "browserMode") {
    const { handleBrowserModeCommand } = await import("./settings-handler");
    return handleBrowserModeCommand(ctx, chatId, command);
  }

  if (command.kind === "unknown") {
    await ctx.api.sendMessage(chatId, buildUnknownCommandMessage(commandInput));
    return;
  }
}
