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
const EXTRACT_JOB_PREFIXES = ["extract:", "force:", "full:", "lightpanda:"];
const BLOCKED_MARKERS = [
  "blocked/no readable content",
  "anti-bot",
  "captcha",
  "access denied",
  "unauthorized",
  "security verification",
  "verify you are not a bot",
];

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

function isExtractLikeJob(label: string): boolean {
  return EXTRACT_JOB_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function looksLikeBlockedError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lowered.includes(marker));
}

export function buildJobFailureHint(
  label: string,
  errorDetail: string,
): string | null {
  const detail = errorDetail.toLowerCase();

  if (isExtractLikeJob(label) && looksLikeBlockedError(errorDetail)) {
    return "Site kemungkinan memblokir request. Coba `/browser on`, import cookie login via `/cookieimport <domain>`, lalu ulang `/extract <url> 1`.";
  }

  if (isExtractLikeJob(label) && isTimeoutLikeError(errorDetail)) {
    return "Job extract timeout. Coba ulang dengan halaman kecil (`/extract <url> 1`) atau hentikan job aktif pakai `/cancel`.";
  }

  if (label.startsWith("subtitle:") && detail.includes("timeout")) {
    return "Job subtitle timeout. Coba ulang `/subtitle <youtube-url>` dan update binary via `/ytdlp update` bila perlu.";
  }

  return null;
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

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function createTimedAbortSignal(
  timeoutMs: number,
  baseSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(`Job timeout (${timeoutMs}ms)`));
  }, timeoutMs);

  const onBaseAbort = (): void => {
    controller.abort(baseSignal.reason ?? new Error("Aborted"));
  };

  if (baseSignal.aborted) {
    onBaseAbort();
  } else {
    baseSignal.addEventListener("abort", onBaseAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      baseSignal.removeEventListener("abort", onBaseAbort);
    },
    didTimeout: () => didTimeout,
  };
}
