import { describe, expect, test } from "bun:test";
import { formatLogLine, isLogLevelEnabled, resolveLogLevel } from "./logger";

describe("formatLogLine", () => {
  test("renders timestamp, level, component, message", () => {
    const line = formatLogLine({
      level: "info",
      component: "telegram-bot",
      message: "bot started",
      now: new Date("2026-02-20T00:00:00.000Z"),
    });

    expect(line).toContain("2026-02-20T00:00:00.000Z");
    expect(line).toContain("[INFO]");
    expect(line).toContain("[telegram-bot]");
    expect(line).toContain("bot started");
  });

  test("renders context data and error text", () => {
    const line = formatLogLine({
      level: "error",
      component: "telegram-bot",
      message: "send failed",
      context: { chatId: 10, action: "sendDocument" },
      error: new Error("network down"),
      now: new Date("2026-02-20T00:00:00.000Z"),
    });

    expect(line).toContain("[ERROR]");
    expect(line).toContain("chatId=10");
    expect(line).toContain("action=sendDocument");
    expect(line).toContain("error=network down");
  });

  test("sanitizes and truncates long context value", () => {
    const line = formatLogLine({
      level: "info",
      component: "telegram-bot",
      message: "extract progress",
      context: {
        detail: `${"x".repeat(220)}\nsecond-line`,
      },
      now: new Date("2026-02-20T00:00:00.000Z"),
    });

    expect(line).toContain("detail=");
    expect(line).toContain("...(truncated:");
    expect(line).not.toContain("\nsecond-line");
  });

  test("resolves and compares log levels", () => {
    expect(resolveLogLevel("debug")).toBe("debug");
    expect(resolveLogLevel("error")).toBe("error");
    expect(resolveLogLevel("unknown")).toBe("info");

    expect(isLogLevelEnabled("debug", "info")).toBeFalse();
    expect(isLogLevelEnabled("info", "info")).toBeTrue();
    expect(isLogLevelEnabled("error", "warn")).toBeTrue();
  });
});
