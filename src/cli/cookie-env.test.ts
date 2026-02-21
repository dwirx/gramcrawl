import { describe, expect, test } from "bun:test";
import {
  extractCookieHeaderFromNetscape,
  extractCookieMapFromNetscape,
  hasCookieName,
  writeCookieToEnv,
} from "./cookie-env";

describe("extractCookieHeaderFromNetscape", () => {
  test("reads cookie header for matching domain", () => {
    const raw = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.projectmultatuli.org\tTRUE\t/\tTRUE\t9999999999\tcf_clearance\tabc123",
      ".projectmultatuli.org\tTRUE\t/\tFALSE\t9999999999\t__cf_bm\tdef456",
      ".example.com\tTRUE\t/\tFALSE\t9999999999\tsession\tzzz",
    ].join("\n");

    const cookie = extractCookieHeaderFromNetscape(raw, "projectmultatuli.org");

    expect(cookie).toContain("cf_clearance=abc123");
    expect(cookie).toContain("__cf_bm=def456");
    expect(cookie).not.toContain("session=zzz");
  });
});

describe("writeCookieToEnv", () => {
  test("upserts EXTRACT_COOKIE_MAP in env file", async () => {
    const envPath = `/tmp/extract-cookie-env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`;
    await Bun.write(envPath, "TELEGRAM_BOT_TOKEN=xxx\n");

    await writeCookieToEnv(
      envPath,
      "projectmultatuli.org",
      "cf_clearance=abc123; __cf_bm=def456",
    );

    const text = await Bun.file(envPath).text();
    expect(text).toContain("TELEGRAM_BOT_TOKEN=xxx");
    expect(text).toContain("EXTRACT_COOKIE_MAP=");
    expect(text).toContain("projectmultatuli.org");
    expect(text).toContain("cf_clearance=abc123");
    expect(process.env.EXTRACT_COOKIE_MAP).toContain("projectmultatuli.org");
  });
});

describe("extractCookieMapFromNetscape", () => {
  test("builds cookie map for all domains", () => {
    const raw = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.projectmultatuli.org\tTRUE\t/\tTRUE\t9999999999\tcf_clearance\tabc123",
      ".projectmultatuli.org\tTRUE\t/\tFALSE\t9999999999\t__cf_bm\tdef456",
      ".example.com\tTRUE\t/\tFALSE\t9999999999\tsession\tzzz",
    ].join("\n");

    const map = extractCookieMapFromNetscape(raw);

    expect(map["projectmultatuli.org"]).toContain("cf_clearance=abc123");
    expect(map["projectmultatuli.org"]).toContain("__cf_bm=def456");
    expect(map["example.com"]).toContain("session=zzz");
  });
});

describe("hasCookieName", () => {
  test("detects cookie name in header", () => {
    expect(hasCookieName("cf_clearance=abc; __cf_bm=def", "cf_clearance")).toBe(
      true,
    );
    expect(hasCookieName("cf_clearance=abc; __cf_bm=def", "__cf_bm")).toBe(
      true,
    );
    expect(hasCookieName("foo=bar", "cf_clearance")).toBe(false);
  });
});
