export type TelegramChatActionLike = "typing" | "upload_document";

type SendChatAction = (
  chatId: number,
  action: TelegramChatActionLike,
) => Promise<void>;

type ChatActionHeartbeatOptions = {
  intervalMs?: number;
};

const DEFAULT_CHAT_ACTION_HEARTBEAT_MS = 4_500;
const POLLING_TIMEOUT_BASE_BACKOFF_MS = 2_000;
const POLLING_TIMEOUT_MAX_BACKOFF_MS = 16_000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export function isTimeoutLikeError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("abort")
  );
}

export function pollingTimeoutBackoffMs(consecutiveTimeouts: number): number {
  const safeTimeoutCount = Math.max(1, Math.floor(consecutiveTimeouts));
  const exponent = Math.min(safeTimeoutCount - 1, 3);
  const backoff = POLLING_TIMEOUT_BASE_BACKOFF_MS * 2 ** exponent;
  return Math.min(POLLING_TIMEOUT_MAX_BACKOFF_MS, backoff);
}

export function shouldLogPollingTimeout(consecutiveTimeouts: number): boolean {
  return consecutiveTimeouts <= 1 || consecutiveTimeouts % 5 === 0;
}

export async function runWithChatActionHeartbeat<T>(
  sendChatAction: SendChatAction,
  chatId: number,
  action: TelegramChatActionLike,
  run: () => Promise<T>,
  options?: ChatActionHeartbeatOptions,
): Promise<T> {
  const intervalMs = options?.intervalMs ?? DEFAULT_CHAT_ACTION_HEARTBEAT_MS;
  let active = true;

  const beat = async (): Promise<void> => {
    if (!active) {
      return;
    }

    try {
      await sendChatAction(chatId, action);
    } catch {
      // Best effort only, chat action failure should not fail the job.
    }
  };

  await beat();
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);

  try {
    return await run();
  } finally {
    active = false;
    clearInterval(timer);
  }
}
