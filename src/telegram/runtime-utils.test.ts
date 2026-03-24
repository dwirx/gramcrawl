import { describe, expect, test } from "bun:test";
import {
  buildJobFailureHint,
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

  test("builds actionable hint for blocked extract jobs", () => {
    const hint = buildJobFailureHint(
      "extract:https://www.wsj.com/article",
      "blocked/no readable content because anti-bot",
    );

    expect(hint).not.toBeNull();
    expect(hint).toContain("/browser on");
    expect(hint).toContain("/cookieimport <domain>");
  });

  test("builds timeout hint for extract jobs", () => {
    const hint = buildJobFailureHint(
      "extract:https://example.com/post",
      "Job timeout (120000ms)",
    );

    expect(hint).not.toBeNull();
    expect(hint).toContain("/extract <url> 1");
    expect(hint).toContain("/cancel");
  });

  test("returns null for generic non-matching failures", () => {
    const hint = buildJobFailureHint(
      "mark:https://example.com/post",
      "Something went wrong",
    );

    expect(hint).toBeNull();
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
