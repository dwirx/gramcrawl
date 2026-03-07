import { describe, expect, test } from "bun:test";
import {
  extractArchiveOriginalUrl,
  isArchiveHost,
  unwrapArchiveProxyUrl,
} from "./archive-utils";

describe("archive-utils", () => {
  test("detects archive host variants", () => {
    expect(isArchiveHost("archive.is")).toBeTrue();
    expect(isArchiveHost("archive.today")).toBeTrue();
    expect(isArchiveHost("archive.ph")).toBeTrue();
    expect(isArchiveHost("example.com")).toBeFalse();
  });

  test("extracts original url from timestamp archive snapshot", () => {
    const original = extractArchiveOriginalUrl(
      "https://archive.is/20260305202935/https://www.nytimes.com/2026/03/05/world/middleeast/iran-school-us-strikes-naval-base.html",
    );

    expect(original).toBe(
      "https://www.nytimes.com/2026/03/05/world/middleeast/iran-school-us-strikes-naval-base.html",
    );
  });

  test("extracts original url from archive o/<id> links", () => {
    const original = extractArchiveOriginalUrl(
      "https://archive.is/o/Zh6oK/https://www.nytimes.com/section/world",
    );

    expect(original).toBe("https://www.nytimes.com/section/world");
  });

  test("unwraps archive proxy url to original", () => {
    const unwrapped = unwrapArchiveProxyUrl(
      "https://archive.is/o/Zh6oK/https://www.nytimes.com/section/world",
    );

    expect(unwrapped).toBe("https://www.nytimes.com/section/world");
  });
});
