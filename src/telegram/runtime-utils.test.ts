import { describe, expect, test } from "bun:test";
import {
  isTimeoutLikeError,
  pollingTimeoutBackoffMs,
  runWithChatActionHeartbeat,
  shouldLogPollingTimeout,
  type TelegramChatActionLike,
} from "./runtime-utils";

describe("telegram runtime utils", () => {
  test("detects timeout-like error messages", () => {
    expect(
      isTimeoutLikeError(new Error("The operation timed out.")),
    ).toBeTrue();
    expect(isTimeoutLikeError(new Error("request aborted"))).toBeTrue();
    expect(isTimeoutLikeError("timeout while connecting")).toBeTrue();
    expect(isTimeoutLikeError(new Error("Bad Gateway"))).toBeFalse();
  });

  test("calculates bounded polling timeout backoff", () => {
    expect(pollingTimeoutBackoffMs(1)).toBe(2_000);
    expect(pollingTimeoutBackoffMs(2)).toBe(4_000);
    expect(pollingTimeoutBackoffMs(3)).toBe(8_000);
    expect(pollingTimeoutBackoffMs(20)).toBe(16_000);
  });

  test("logs timeout on first and every fifth retry", () => {
    expect(shouldLogPollingTimeout(1)).toBeTrue();
    expect(shouldLogPollingTimeout(2)).toBeFalse();
    expect(shouldLogPollingTimeout(4)).toBeFalse();
    expect(shouldLogPollingTimeout(5)).toBeTrue();
    expect(shouldLogPollingTimeout(10)).toBeTrue();
  });

  test("keeps chat action heartbeat during long task and stops afterwards", async () => {
    const calls: TelegramChatActionLike[] = [];

    await runWithChatActionHeartbeat(
      async (_chatId, action) => {
        calls.push(action);
      },
      10,
      "typing",
      async () => {
        await Bun.sleep(45);
      },
      { intervalMs: 10 },
    );

    expect(calls.length).toBeGreaterThanOrEqual(3);

    const stableCount = calls.length;
    await Bun.sleep(30);
    expect(calls.length).toBe(stableCount);
  });
});
