import { describe, expect, test } from "bun:test";
import {
  parseSrtToTimestampText,
  pickPreferredSubtitleLanguages,
  parseVttToTimestampText,
  resolveOriginalLanguage,
  sortSubtitleLanguages,
} from "./service";

describe("subtitle timestamp parser", () => {
  test("parses SRT into timestamp lines", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "Hello world",
      "",
      "2",
      "00:00:04,500 --> 00:00:06,200",
      "Second line",
      "",
    ].join("\n");

    const parsed = parseSrtToTimestampText(raw);
    expect(parsed).toContain("[00:00:01] Hello world");
    expect(parsed).toContain("[00:00:04] Second line");
  });

  test("parses VTT into timestamp lines", () => {
    const raw = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "Hello world",
      "",
      "00:00:04.500 --> 00:00:06.200",
      "Second line",
      "",
    ].join("\n");

    const parsed = parseVttToTimestampText(raw);
    expect(parsed).toContain("[00:00:01] Hello world");
    expect(parsed).toContain("[00:00:04] Second line");
  });

  test("sorts manual subtitles before auto subtitles", () => {
    const sorted = sortSubtitleLanguages([
      { code: "id", hasManual: false, hasAuto: true },
      { code: "en", hasManual: true, hasAuto: true },
      { code: "fr", hasManual: true, hasAuto: false },
    ]);

    expect(sorted[0]?.code).toBe("en");
    expect(sorted[1]?.code).toBe("fr");
    expect(sorted[2]?.code).toBe("id");
  });

  test("picks only original/en/id as preferred languages", () => {
    const preferred = pickPreferredSubtitleLanguages(
      [
        { code: "es", hasManual: true, hasAuto: false },
        { code: "en", hasManual: true, hasAuto: true },
        { code: "id", hasManual: false, hasAuto: true },
        { code: "fr", hasManual: true, hasAuto: false },
      ],
      "es-MX",
    );

    expect(preferred.map((item) => item.code)).toEqual(["es", "en", "id"]);
  });

  test("resolves original language from manual fallback", () => {
    const resolved = resolveOriginalLanguage(
      [
        { code: "fr", hasManual: true, hasAuto: false },
        { code: "en", hasManual: true, hasAuto: true },
      ],
      null,
    );

    expect(resolved).toBe("fr");
  });
});
