import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./cli/parse-args";
import { normalizeLegacyArgs } from "./index";
import { buildSiteFolderName } from "./app/run-store";
import {
  buildArticleMarkdown,
  buildArticleText,
  buildMarkdownFromBlocks,
  slugifyTitle,
} from "./extractor/markdown";
import { normalizeScopedUrl } from "./extractor/url-utils";
import type { ContentBlock } from "./extractor/types";

describe("parseCliArgs", () => {
  test("parses extract command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "extract",
      "https://example.com/article",
      "5",
    ]);

    expect(command.command).toBe("extract");
    if (command.command !== "extract") {
      throw new Error("Expected extract command");
    }

    expect(command.url).toBe("https://example.com/article");
    expect(command.maxPages).toBe(5);
  });

  test("parses list command", () => {
    const command = parseCliArgs(["bun", "src/cli.ts", "list", "--limit", "7"]);

    expect(command.command).toBe("list");
    if (command.command !== "list") {
      throw new Error("Expected list command");
    }

    expect(command.limit).toBe(7);
  });

  test("parses cookie-import command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "cookie-import",
      "projectmultatuli.org",
      "cookies.txt",
    ]);

    expect(command.command).toBe("cookie-import");
    if (command.command !== "cookie-import") {
      throw new Error("Expected cookie-import command");
    }

    expect(command.domain).toBe("projectmultatuli.org");
    expect(command.cookiesFile).toBe("cookies.txt");
  });

  test("parses cookie-set command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "cookie-set",
      "projectmultatuli.org",
      "cf_clearance=abc",
    ]);

    expect(command.command).toBe("cookie-set");
    if (command.command !== "cookie-set") {
      throw new Error("Expected cookie-set command");
    }

    expect(command.domain).toBe("projectmultatuli.org");
    expect(command.cookie).toBe("cf_clearance=abc");
  });

  test("parses subtitle command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "subtitle",
      "https://www.youtube.com/watch?v=7ZdPKEf-LXA",
      "--lang",
      "en",
    ]);

    expect(command.command).toBe("subtitle");
    if (command.command !== "subtitle") {
      throw new Error("Expected subtitle command");
    }

    expect(command.url).toBe("https://www.youtube.com/watch?v=7ZdPKEf-LXA");
    expect(command.lang).toBe("en");
  });
});

describe("normalizeLegacyArgs", () => {
  test("rewrites legacy args to extract command", () => {
    const normalized = normalizeLegacyArgs([
      "bun",
      "src/index.ts",
      "https://example.com/article",
      "3",
    ]);

    expect(normalized[2]).toBe("extract");
    expect(normalized[3]).toBe("https://example.com/article");
    expect(normalized[4]).toBe("3");
  });
});

describe("buildSiteFolderName", () => {
  test("uses hostname as folder name", () => {
    expect(
      buildSiteFolderName(
        "https://www.theverge.com/column/abc/example-article",
      ),
    ).toBe("www.theverge.com");
  });
});

describe("normalizeScopedUrl", () => {
  const rootUrl = new URL("https://cheerio.js.org/docs/");
  const currentPageUrl = new URL("https://cheerio.js.org/docs/intro");

  test("normalizes in-scope relative links", () => {
    const result = normalizeScopedUrl("./api", currentPageUrl, rootUrl);

    expect(result).toBe("https://cheerio.js.org/docs/api");
  });

  test("removes hash from links", () => {
    const result = normalizeScopedUrl(
      "/docs/intro#section",
      currentPageUrl,
      rootUrl,
    );

    expect(result).toBe("https://cheerio.js.org/docs/intro");
  });

  test("rejects external links", () => {
    const result = normalizeScopedUrl(
      "https://example.com",
      currentPageUrl,
      rootUrl,
    );

    expect(result).toBeNull();
  });
});

describe("markdown helpers", () => {
  test("slugifyTitle creates safe file names", () => {
    expect(
      slugifyTitle("From Quantitative Strength to Transformative Discipline!"),
    ).toBe("from-quantitative-strength-to-transformative-discipline");
  });

  test("buildArticleMarkdown returns frontmatter and body", () => {
    const markdown = buildArticleMarkdown(
      {
        url: "https://example.com/post",
        articleTitle: "Contoh Artikel",
        description: "Ini ringkasan",
        articleBodyText: "Paragraf pertama.\n\nParagraf kedua.",
        contentBlocks: [
          { type: "text", tag: "p", text: "Paragraf pertama." },
          { type: "text", tag: "p", text: "Paragraf kedua." },
        ],
        publishedAt: "2026-02-20T00:00:00.000Z",
      },
      "2026-02-20T00:00:00.000Z",
    );

    expect(markdown).toContain("TITLE: Contoh Artikel");
    expect(markdown).toContain("# Contoh Artikel");
    expect(markdown).toContain("_Ini ringkasan_");
    expect(markdown).toContain("* * *");
    expect(markdown).toContain("Paragraf pertama.");
    expect(markdown).toContain("Paragraf kedua.");
  });

  test("buildMarkdownFromBlocks keeps text-image order", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "p", text: "Paragraf awal." },
      {
        type: "image",
        src: "https://example.com/image-a.jpg",
        alt: "Gambar A",
        caption: "Caption A",
      },
      { type: "text", tag: "p", text: "Paragraf setelah gambar." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    const imageIndex = markdown.indexOf(
      "![Gambar A](https://example.com/image-a.jpg)",
    );
    const firstTextIndex = markdown.indexOf("Paragraf awal.");
    const secondTextIndex = markdown.indexOf("Paragraf setelah gambar.");

    expect(firstTextIndex).toBeLessThan(imageIndex);
    expect(imageIndex).toBeLessThan(secondTextIndex);
    expect(markdown).toContain("_Gambar 1: Caption A_");
  });

  test("buildArticleText returns plain text output", () => {
    const textOutput = buildArticleText(
      {
        url: "https://example.com/post",
        articleTitle: "Contoh Artikel",
        description: "Ini ringkasan",
        articleBodyText: "Paragraf pertama.\n\nParagraf kedua.",
        contentBlocks: [
          { type: "text", tag: "p", text: "Paragraf pertama." },
          {
            type: "image",
            src: "https://example.com/image-a.jpg",
            alt: "Gambar A",
            caption: "Caption A",
          },
          { type: "text", tag: "p", text: "Paragraf kedua." },
        ],
        publishedAt: "2026-02-20T00:00:00.000Z",
      },
      "2026-02-20T00:00:00.000Z",
    );

    expect(textOutput).toContain("TITLE: Contoh Artikel");
    expect(textOutput).toContain("SOURCE: https://example.com/post");
    expect(textOutput).toContain("_Ini ringkasan_");
    expect(textOutput).toContain("Paragraf pertama.");
    expect(textOutput).toContain("Paragraf kedua.");
    expect(textOutput).toContain("[IMAGE 1] https://example.com/image-a.jpg");
    expect(textOutput).toContain("CAPTION: Caption A");
  });
});
