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

  test("parses /mark command", () => {
    const parsed = parseTelegramCommand("/mark https://si.inc/posts/fdm1/");

    expect(parsed.kind).toBe("mark");
    if (parsed.kind !== "mark") {
      throw new Error("Expected mark command");
    }

    expect(parsed.url).toBe("https://si.inc/posts/fdm1/");
  });

  test("parses /md command as mark alias", () => {
    const parsed = parseTelegramCommand("/md https://si.inc/posts/fdm1/");

    expect(parsed.kind).toBe("mark");
    if (parsed.kind !== "mark") {
      throw new Error("Expected mark command");
    }

    expect(parsed.url).toBe("https://si.inc/posts/fdm1/");
  });

  test("parses /defuddle command", () => {
    const parsed = parseTelegramCommand("/defuddle https://si.inc/posts/fdm1/");

    expect(parsed.kind).toBe("defuddle");
    if (parsed.kind !== "defuddle") {
      throw new Error("Expected defuddle command");
    }

    expect(parsed.url).toBe("https://si.inc/posts/fdm1/");
  });

  test("parses /df command as defuddle alias", () => {
    const parsed = parseTelegramCommand("/df https://si.inc/posts/fdm1/");

    expect(parsed.kind).toBe("defuddle");
    if (parsed.kind !== "defuddle") {
      throw new Error("Expected defuddle command");
    }

    expect(parsed.url).toBe("https://si.inc/posts/fdm1/");
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

  test("parses /runs with bot mention", () => {
    const parsed = parseTelegramCommand("/runs@teleextract_bot 7");

    expect(parsed.kind).toBe("runs");
    if (parsed.kind !== "runs") {
      throw new Error("Expected runs command");
    }

    expect(parsed.limit).toBe(7);
  });

  test("caps /runs limit to prevent oversized responses", () => {
    const parsed = parseTelegramCommand("/runs 9999");

    expect(parsed.kind).toBe("runs");
    if (parsed.kind !== "runs") {
      throw new Error("Expected runs command");
    }

    expect(parsed.limit).toBe(20);
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

  test("caps /extract maxPages for safety", () => {
    const parsed = parseTelegramCommand(
      "/extract https://example.com/article 999",
    );

    expect(parsed.kind).toBe("extract");
    if (parsed.kind !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(parsed.maxPages).toBe(30);
  });

  test("parses command names case-insensitively", () => {
    const parsed = parseTelegramCommand(
      "/EXTRACT https://example.com/article 2",
    );

    expect(parsed.kind).toBe("extract");
    if (parsed.kind !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(parsed.maxPages).toBe(2);
  });

  test("does not treat command prefixes as valid commands", () => {
    expect(parseTelegramCommand("/runs123 9").kind).toBe("unknown");
    expect(parseTelegramCommand("/extractor https://example.com").kind).toBe(
      "unknown",
    );
    expect(
      parseTelegramCommand("/subtitlex https://youtube.com/watch?v=1").kind,
    ).toBe("unknown");
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

  test("parses /ytdlp with default status action", () => {
    const parsed = parseTelegramCommand("/ytdlp");

    expect(parsed.kind).toBe("ytDlp");
    if (parsed.kind !== "ytDlp") {
      throw new Error("Expected ytDlp command");
    }

    expect(parsed.action).toBe("status");
  });

  test("parses /ytdlp version action", () => {
    const parsed = parseTelegramCommand("/ytdlp version");

    expect(parsed.kind).toBe("ytDlp");
    if (parsed.kind !== "ytDlp") {
      throw new Error("Expected ytDlp command");
    }

    expect(parsed.action).toBe("version");
  });

  test("parses /ytdlp update action with bot mention", () => {
    const parsed = parseTelegramCommand("/ytdlp@teleextract_bot update");

    expect(parsed.kind).toBe("ytDlp");
    if (parsed.kind !== "ytDlp") {
      throw new Error("Expected ytDlp command");
    }

    expect(parsed.action).toBe("update");
  });

  test("rejects invalid /ytdlp action", () => {
    const parsed = parseTelegramCommand("/ytdlp force");

    expect(parsed.kind).toBe("unknown");
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

  test("parses /cancel command", () => {
    const parsed = parseTelegramCommand("/cancel");

    expect(parsed.kind).toBe("cancel");
  });

  test("parses /stop command as cancel alias", () => {
    const parsed = parseTelegramCommand("/stop");

    expect(parsed.kind).toBe("cancel");
  });

  test("parses /restart command", () => {
    const parsed = parseTelegramCommand("/restart");

    expect(parsed.kind).toBe("restart");
  });

  test("parses /stats command", () => {
    const parsed = parseTelegramCommand("/stats");

    expect(parsed.kind).toBe("stats");
  });

  test("parses /clearcache command", () => {
    const parsed = parseTelegramCommand("/clearcache");

    expect(parsed.kind).toBe("clearCache");
  });

  test("parses /clearchat with bounded limit", () => {
    const parsed = parseTelegramCommand("/clearchat 200");

    expect(parsed.kind).toBe("clearChat");
    if (parsed.kind !== "clearChat") {
      throw new Error("Expected clearChat command");
    }

    expect(parsed.limit).toBe(100);
  });

  test("parses /cleanoutput all", () => {
    const parsed = parseTelegramCommand("/cleanoutput all");

    expect(parsed.kind).toBe("cleanOutput");
    if (parsed.kind !== "cleanOutput") {
      throw new Error("Expected cleanOutput command");
    }

    expect(parsed.scope).toBe("all");
  });

  test("parses /cleanoutput by site", () => {
    const parsed = parseTelegramCommand("/cleanoutput example.com");

    expect(parsed.kind).toBe("cleanOutput");
    if (parsed.kind !== "cleanOutput") {
      throw new Error("Expected cleanOutput command");
    }

    expect(parsed.scope).toBe("site");
    expect(parsed.site).toBe("example.com");
  });

  test("parses /cleandownloads by site", () => {
    const parsed = parseTelegramCommand("/cleandownloads example.com");

    expect(parsed.kind).toBe("cleanDownloads");
    if (parsed.kind !== "cleanDownloads") {
      throw new Error("Expected cleanDownloads command");
    }

    expect(parsed.scope).toBe("site");
    expect(parsed.site).toBe("example.com");
  });
});
