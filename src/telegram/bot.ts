import { createLogger } from "./logger";
import { TelegramApi } from "./api/client";
import { QueueService } from "./services/queue";
import { CacheService } from "./services/cache";
import { SessionService } from "./services/session";
import { RateLimitService } from "./services/rate-limit";
import { BotConfigSchema, type BotConfig } from "./types";
import {
  EXTRACT_CACHE_DEFAULT_MAX_ENTRIES,
  BOT_RATE_LIMIT_DEFAULT_WINDOW_MS,
  BOT_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
} from "./constants";
import {
  readPositiveIntEnv,
  pollingTimeoutBackoffMs,
  shouldLogPollingTimeout,
} from "./runtime-utils";
import { buildTelegramCommandSuggestions } from "./ui/keyboard";
import { handleMessage } from "./handlers/command";
import { handleCallbackQuery } from "./handlers/callback";
import type { BotContext } from "./context";

export async function startTelegramBot(configInput: BotConfig): Promise<void> {
  const config = BotConfigSchema.parse(configInput);
  const api = new TelegramApi(config.token);
  const logger = createLogger("telegram-bot");

  const extractCacheMaxEntries = readPositiveIntEnv(
    "EXTRACT_BOT_CACHE_MAX_ENTRIES",
    EXTRACT_CACHE_DEFAULT_MAX_ENTRIES,
  );
  const rateLimitWindowMs = readPositiveIntEnv(
    "EXTRACT_BOT_RATE_LIMIT_WINDOW_MS",
    BOT_RATE_LIMIT_DEFAULT_WINDOW_MS,
  );
  const rateLimitMaxRequests = readPositiveIntEnv(
    "EXTRACT_BOT_RATE_LIMIT_MAX_REQUESTS",
    BOT_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
  );

  const ctx: BotContext = {
    api,
    config,
    logger,
    queue: new QueueService(api),
    cache: new CacheService(extractCacheMaxEntries),
    sessions: new SessionService(),
    rateLimit: new RateLimitService(rateLimitWindowMs, rateLimitMaxRequests),
    botStartedAt: Date.now(),
  };

  const tokenHint = `${config.token.slice(0, 6)}...${config.token.slice(-4)}`;

  await logger.info("bot started", {
    outputRoot: config.outputRoot,
    token: tokenHint,
  });

  try {
    await api.setMyCommands(buildTelegramCommandSuggestions());
    await logger.info("telegram command suggestions synced");
  } catch (error) {
    await logger.warn("failed to sync telegram command suggestions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let offset: number | undefined;
  let consecutivePollingTimeouts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await api.getUpdates(offset);
      if (consecutivePollingTimeouts > 0) {
        await logger.info("polling recovered", {
          previousTimeouts: consecutivePollingTimeouts,
        });
        consecutivePollingTimeouts = 0;
      }

      if (updates.length > 0) {
        await logger.debug("updates fetched", { count: updates.length });
      }

      for (const update of updates) {
        try {
          offset = update.update_id + 1;

          ctx.sessions.cleanup();
          ctx.cache.cleanup();

          if (update.callback_query) {
            await handleCallbackQuery(ctx, update.callback_query);
          } else if (update.message) {
            await handleMessage(ctx, update.message);
          }
        } catch (updateError) {
          await logger.error("failed to process update", updateError, {
            updateId: update.update_id,
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("timeout")) {
        consecutivePollingTimeouts += 1;
        if (shouldLogPollingTimeout(consecutivePollingTimeouts)) {
          await logger.warn("polling timeout", {
            consecutive: consecutivePollingTimeouts,
          });
        }
        await Bun.sleep(pollingTimeoutBackoffMs(consecutivePollingTimeouts));
        continue;
      }

      await logger.error("fatal polling error", error);
      await Bun.sleep(5000);
    }
  }
}
