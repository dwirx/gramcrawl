import type { BotContext } from "../context";
import { modeLabel, modeEnvValue } from "../ui/formatter";
import {
  isBrowserFallbackEnabled,
  writeBrowserFallbackToEnv,
} from "./subtitle-utils";
import type { TelegramCommand } from "../command-parser";

export async function handleBrowserModeCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "browserMode" }>,
): Promise<void> {
  if (command.action === "status") {
    const enabled = isBrowserFallbackEnabled();
    await ctx.api.sendMessage(
      chatId,
      [
        "Status browser fallback:",
        `• Mode: ${modeLabel(enabled)}`,
        `• EXTRACT_BROWSER_FALLBACK=${modeEnvValue(enabled)}`,
      ].join("\n"),
    );
    return;
  }

  const enabled = command.action === "on";
  await writeBrowserFallbackToEnv(ctx.config.envPath, enabled);
  await ctx.api.sendMessage(
    chatId,
    [
      `Browser fallback berhasil di-${enabled ? "aktifkan" : "nonaktifkan"}.`,
      `Mode sekarang: ${modeLabel(enabled)}`,
      `EXTRACT_BROWSER_FALLBACK=${modeEnvValue(enabled)}`,
      `Disimpan di ${ctx.config.envPath} dan langsung aktif di proses bot ini.`,
    ].join("\n"),
  );
  await ctx.logger.info("browser mode changed", {
    chatId,
    action: command.action,
    envPath: ctx.config.envPath,
  });
}
