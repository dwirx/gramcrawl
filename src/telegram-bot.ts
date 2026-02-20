import { startTelegramBot } from "./telegram/bot";
import { createLogger } from "./telegram/logger";

const token = process.env.TELEGRAM_BOT_TOKEN;
const outputRoot = process.env.EXTRACT_OUTPUT_ROOT ?? "output";
const envPath = process.env.EXTRACT_ENV_PATH ?? ".env";
const logger = createLogger("telegram-runner");

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN belum diset di environment");
}

await logger.info("starting telegram bot process", { outputRoot, envPath });
await logger.info("shutdown hint", { usage: "Ctrl+C to stop bot" });

try {
  await startTelegramBot({ token, outputRoot, envPath });
} catch (error) {
  await logger.error("bot process terminated with error", error);
  process.exitCode = 1;
}
