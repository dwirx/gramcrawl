import type { BotContext } from "../context";
import { buildStatusCard } from "../ui/formatter";
import { updateYtDlpBinary, getYtDlpStatus } from "../../subtitle/service";
import type { TelegramCommand } from "../command-parser";

export function ytDlpModeLabel(
  mode: "managed-local" | "configured" | "path",
): string {
  if (mode === "managed-local") {
    return "Managed local (.cache/bin)";
  }
  if (mode === "configured") {
    return "Custom (EXTRACT_YT_DLP_BIN)";
  }
  return "PATH system";
}

export function ytDlpUpdateMethodLabel(
  method: "download-latest" | "self-update",
): string {
  return method === "download-latest"
    ? "Download latest release"
    : "Self update (-U)";
}

export async function handleYtDlpCommand(
  ctx: BotContext,
  chatId: number,
  command: Extract<TelegramCommand, { kind: "ytDlp" }>,
): Promise<void> {
  await ctx.api.sendChatAction(chatId, "typing");
  const statusMessageId = await ctx.api.sendMessage(
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

      await ctx.api.editMessage(
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

      await ctx.logger.info("yt-dlp updated", {
        chatId,
        beforeVersion: updated.before.version,
        afterVersion: updated.after.version,
        method: updated.method,
        binary: updated.after.binary,
      });
      return;
    }

    const status = await getYtDlpStatus();
    const title =
      command.action === "version" ? "✅ Versi yt-dlp" : "✅ Status yt-dlp";
    await ctx.api.editMessage(
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

    await ctx.logger.info("yt-dlp status sent", {
      chatId,
      action: command.action,
      version: status.version,
      mode: status.mode,
      binary: status.binary,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await ctx.api.editMessage(
      chatId,
      statusMessageId,
      buildStatusCard("❌ Operasi yt-dlp gagal", [
        { label: "Aksi", value: command.action },
        { label: "Detail", value: detail.slice(0, 350) },
      ]),
    );
    await ctx.logger.error("yt-dlp command failed", error, {
      chatId,
      action: command.action,
    });
  }
}
