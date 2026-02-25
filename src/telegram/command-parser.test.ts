import { describe, expect, test } from "bun:test";
import { parseTelegramCommand } from "./command-parser";

describe("parseTelegramCommand", () => {
  test("parses /extract command", () => {
    const parsed = parseTelegramCommand(
      "/extract https://example.com/article 2",
    );

    expect(parsed.kind).toBe("extract");
    if (parsed.kind !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(parsed.url).toBe("https://example.com/article");
    expect(parsed.maxPages).toBe(2);
  });

  test("parses /subtitle command", () => {
    const parsed = parseTelegramCommand(
      "/subtitle https://www.youtube.com/watch?v=7ZdPKEf-LXA",
    );

    expect(parsed.kind).toBe("subtitle");
    if (parsed.kind !== "subtitle") {
      throw new Error("Expected subtitle command");
    }

    expect(parsed.url).toBe("https://www.youtube.com/watch?v=7ZdPKEf-LXA");
  });

  test("parses /scribd command as extract with maxPages=1", () => {
    const parsed = parseTelegramCommand(
      "/scribd https://www.scribd.com/document/123456789/sample",
    );

    expect(parsed.kind).toBe("extract");
    if (parsed.kind !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(parsed.url).toBe("https://www.scribd.com/document/123456789/sample");
    expect(parsed.maxPages).toBe(1);
  });

  test("rejects /scribd command for non-scribd url", () => {
    const parsed = parseTelegramCommand("/scribd https://example.com/article");

    expect(parsed.kind).toBe("unknown");
  });

  test("parses /subtitletimestamp command", () => {
    const parsed = parseTelegramCommand("/subtitletimestamp off");

    expect(parsed.kind).toBe("subtitleTimestamp");
    if (parsed.kind !== "subtitleTimestamp") {
      throw new Error("Expected subtitleTimestamp command");
    }

    expect(parsed.action).toBe("off");
  });

  test("parses /timestamp alias command", () => {
    const parsed = parseTelegramCommand("/timestamp on");

    expect(parsed.kind).toBe("subtitleTimestamp");
    if (parsed.kind !== "subtitleTimestamp") {
      throw new Error("Expected subtitleTimestamp command");
    }

    expect(parsed.action).toBe("on");
  });

  test("parses /runs command with limit", () => {
    const parsed = parseTelegramCommand("/runs 5");

    expect(parsed.kind).toBe("runs");
    if (parsed.kind !== "runs") {
      throw new Error("Expected runs command");
    }

    expect(parsed.limit).toBe(5);
  });

  test("parses /menu alias as help command", () => {
    const parsed = parseTelegramCommand("/menu");

    expect(parsed.kind).toBe("help");
  });

  test("parses /start as help command", () => {
    const parsed = parseTelegramCommand("/start");

    expect(parsed.kind).toBe("help");
  });

  test("parses /start with bot mention as help command", () => {
    const parsed = parseTelegramCommand("/start@teleextract_bot");

    expect(parsed.kind).toBe("help");
  });

  test("parses /help with bot mention as help command", () => {
    const parsed = parseTelegramCommand("/help@teleextract_bot");

    expect(parsed.kind).toBe("help");
  });

  test("parses plain url as extract command", () => {
    const parsed = parseTelegramCommand("https://example.com/article");

    expect(parsed.kind).toBe("extract");
    if (parsed.kind !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(parsed.url).toBe("https://example.com/article");
    expect(parsed.maxPages).toBe(1);
  });

  test("parses /cookieimport command", () => {
    const parsed = parseTelegramCommand("/cookieimport projectmultatuli.org");

    expect(parsed.kind).toBe("cookieImport");
    if (parsed.kind !== "cookieImport") {
      throw new Error("Expected cookieImport command");
    }

    expect(parsed.domain).toBe("projectmultatuli.org");
  });

  test("parses /browser command", () => {
    const parsed = parseTelegramCommand("/browser on");

    expect(parsed.kind).toBe("browserMode");
    if (parsed.kind !== "browserMode") {
      throw new Error("Expected browserMode command");
    }

    expect(parsed.action).toBe("on");
  });

  test("parses /cookieset command", () => {
    const parsed = parseTelegramCommand(
      "/cookieset projectmultatuli.org cf_clearance=abc; __cf_bm=def",
    );

    expect(parsed.kind).toBe("cookieSet");
    if (parsed.kind !== "cookieSet") {
      throw new Error("Expected cookieSet command");
    }

    expect(parsed.domain).toBe("projectmultatuli.org");
    expect(parsed.cookie).toBe("cf_clearance=abc; __cf_bm=def");
  });
});
