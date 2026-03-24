import type { TelegramApi } from "../api/client";
import type { createLogger } from "../logger";
import { writeCookieToEnv } from "../../cli/cookie-env";

export async function autoImportCookieDocument(
  api: TelegramApi,
  logger: ReturnType<typeof createLogger>,
  chatId: number,
  document: { file_id: string; file_name?: string; mime_type?: string },
  envPath: string,
): Promise<boolean> {
  const fileName = document.file_name?.toLowerCase() ?? "";
  const isCookieFile =
    fileName.endsWith(".txt") ||
    fileName.includes("cookie") ||
    document.mime_type === "text/plain";

  if (!isCookieFile) {
    return false;
  }

  try {
    await api.sendChatAction(chatId, "typing");
    const file = await api.getFilePath(document.file_id);
    if (!file.file_path) {
      throw new Error("File path tidak ditemukan");
    }

    const content = await api.downloadFileText(file.file_path);
    const domainMatch = fileName.match(/cookies?_([a-z0-9.-]+)\.txt/i);
    const targetDomain = domainMatch?.[1] || "";

    if (targetDomain) {
      await writeCookieToEnv(envPath, targetDomain, content);
      await api.sendMessage(
        chatId,
        `✅ Cookie untuk domain ${targetDomain} berhasil diimport dari file.`,
      );
      await logger.info("cookie auto-imported from file", {
        chatId,
        domain: targetDomain,
      });
    } else {
      await writeCookieToEnv(envPath, "", content);
      await api.sendMessage(
        chatId,
        "✅ Cookie berhasil diimport dari file. Domain dideteksi otomatis dari isi file.",
      );
      await logger.info("cookie auto-imported from file (generic)", {
        chatId,
      });
    }
    return true;
  } catch (error) {
    await logger.error("failed to auto-import cookie from file", error, {
      chatId,
    });
    return false;
  }
}
