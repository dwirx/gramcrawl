import { describe, expect, test } from "bun:test";
import { parseRenderedFallbackDocument } from "./rendered-fallback";
import { extractStructuredArticleFromJsonLd } from "./structured-data";

describe("extractStructuredArticleFromJsonLd", () => {
  test("extracts article body from NewsArticle JSON-LD", () => {
    const json = JSON.stringify({
      "@type": "NewsArticle",
      headline: "Judul Artikel",
      description: "Deskripsi Artikel",
      datePublished: "2026-02-20T00:00:00.000Z",
      articleBody: "Paragraf satu.\\nParagraf dua.",
      image: [
        {
          url: "https://example.com/cover.jpg",
        },
      ],
    });

    const result = extractStructuredArticleFromJsonLd(
      [json],
      "Fallback Title",
      "Fallback Desc",
    );

    expect(result).not.toBeNull();
    if (!result) {
      return;
    }

    expect(result.articleTitle).toBe("Judul Artikel");
    expect(result.articleBodyText).toContain("Paragraf satu.");
    expect(result.imageCount).toBe(1);
  });
});

describe("parseRenderedFallbackDocument", () => {
  test("parses title, text, and images from rendered fallback content", () => {
    const raw = [
      "Title: Artikel Demo",
      "",
      "URL Source: http://example.com/a",
      "",
      "Markdown Content:",
      "Paragraf pertama.",
      "",
      "![img](https://example.com/a.jpg)",
      "",
      "Paragraf kedua.",
    ].join("\n");

    const parsed = parseRenderedFallbackDocument(raw);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }

    expect(parsed.articleTitle).toBe("Artikel Demo");
    expect(parsed.articleBodyText).toContain("Paragraf pertama.");
    expect(parsed.imageCount).toBe(1);
  });

  test("parses linked image markdown and keeps content order", () => {
    const raw = [
      "Title: Artikel Dengan Linked Image",
      "",
      "Markdown Content:",
      "Paragraf sebelum.",
      "",
      "[![Panel](https://example.com/panel.png)](https://example.com/source)",
      "",
      "Paragraf sesudah.",
    ].join("\n");

    const parsed = parseRenderedFallbackDocument(raw);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }

    expect(parsed.imageCount).toBe(1);
    expect(parsed.contentBlocks[0]).toEqual({
      type: "text",
      tag: "p",
      text: "Paragraf sebelum.",
    });
    expect(parsed.contentBlocks[1]).toEqual({
      type: "image",
      src: "https://example.com/panel.png",
      alt: "Panel",
      caption: "https://example.com/source",
    });
    expect(parsed.contentBlocks[2]).toEqual({
      type: "text",
      tag: "p",
      text: "Paragraf sesudah.",
    });
  });
});
