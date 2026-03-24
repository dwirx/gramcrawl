import type { TelegramApi } from "./api/client";
import type { QueueService } from "./services/queue";
import type { CacheService } from "./services/cache";
import type { SessionService } from "./services/session";
import type { RateLimitService } from "./services/rate-limit";
import type { BotConfig } from "./types";
import type { createLogger } from "./logger";

export interface BotContext {
  api: TelegramApi;
  config: BotConfig;
  logger: ReturnType<typeof createLogger>;
  queue: QueueService;
  cache: CacheService;
  sessions: SessionService;
  rateLimit: RateLimitService;
  botStartedAt: number;
}
