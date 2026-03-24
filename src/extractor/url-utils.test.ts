import { describe, expect, test } from "bun:test";
import { normalizeExtractionUrl, normalizeScopedUrl } from "./url-utils";

describe("url-utils", () => {
  test("normalizes WSJ URL by removing tracking mod param and hash", () => {
    const normalized = normalizeExtractionUrl(
      "https://www.wsj.com/world/middle-east/sample-article-bdc71ab2?mod=WSJ_home_mediumtopper_pos_2&utm_source=telegram#section",
    );

    expect(normalized).toBe(
      "https://www.wsj.com/world/middle-east/sample-article-bdc71ab2",
    );
  });

  test("keeps non-tracking query params while dropping generic trackers", () => {
    const normalized = normalizeExtractionUrl(
      "https://example.com/search?q=iran&utm_source=google&fbclid=abc123",
    );

    expect(normalized).toBe("https://example.com/search?q=iran");
  });

  test("keeps mod query for non-wsj domains", () => {
    const normalized = normalizeExtractionUrl(
      "https://example.com/article?mod=reader&utm_medium=social",
    );

    expect(normalized).toBe("https://example.com/article?mod=reader");
  });

  test("normalizes in-scope links by removing tracking params", () => {
    const normalized = normalizeScopedUrl(
      "/world/test?utm_source=telegram&gclid=abc123",
      new URL("https://example.com/world/start"),
      new URL("https://example.com/world/start"),
    );

    expect(normalized).toBe("https://example.com/world/test");
  });
});
