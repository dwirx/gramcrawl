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

  test("parses scribd command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "scribd",
      "https://id.scribd.com/document/730392424/test",
      "--out",
      "output-custom",
    ]);

    expect(command.command).toBe("scribd");
    if (command.command !== "scribd") {
      throw new Error("Expected scribd command");
    }

    expect(command.url).toBe("https://id.scribd.com/document/730392424/test");
    expect(command.outputRoot).toBe("output-custom");
  });

  test("parses scribd-browser command", () => {
    const command = parseCliArgs([
      "bun",
      "src/cli.ts",
      "scribd-browser",
      "https://www.scribd.com/document/697321839/sample",
      "--out",
      "downloads",
      "--wait-ms",
      "240000",
      "--format",
      "pdf",
    ]);

    expect(command.command).toBe("scribd-browser");
    if (command.command !== "scribd-browser") {
      throw new Error("Expected scribd-browser command");
    }

    expect(command.url).toBe(
      "https://www.scribd.com/document/697321839/sample",
    );
    expect(command.outputRoot).toBe("downloads");
    expect(command.waitMs).toBe(240000);
    expect(command.format).toBe("pdf");
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

  test("uses original hostname for archive snapshot url", () => {
    expect(
      buildSiteFolderName(
        "https://archive.is/20260305202935/https://www.nytimes.com/2026/03/05/world/middleeast/iran-school-us-strikes-naval-base.html",
      ),
    ).toBe("www.nytimes.com");
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

  test("buildMarkdownFromBlocks renders structured markdown by tag", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "h2", text: "Bagian A" },
      { type: "text", tag: "blockquote", text: "CLI lebih murah." },
      { type: "text", tag: "pre", text: "echo hello\necho world" },
      { type: "text", tag: "li", text: "Poin pertama" },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain("## Bagian A");
    expect(markdown).toContain("> CLI lebih murah.");
    expect(markdown).toContain("```\necho hello\necho world\n```");
    expect(markdown).toContain("- Poin pertama");
  });

  test("buildMarkdownFromBlocks renders table block as markdown table", () => {
    const table = [
      "| Tools used    | MCP     | CLI    | Savings |",
      "| :------------ | :------ | :----- | :------ |",
      "| Session start | ~15,540 | ~300   | 98%     |",
      "| 1 tool        | ~15,570 | ~910   | 94%     |",
    ].join("\n");

    const blocks: ContentBlock[] = [
      { type: "text", tag: "table", text: table },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain(
      "| Tools used    | MCP     | CLI    | Savings |",
    );
    expect(markdown).toContain(
      "| :------------ | :------ | :----- | :------ |",
    );
    expect(markdown).toContain(
      "| Session start | ~15,540 | ~300   | 98%     |",
    );
  });

  test("buildMarkdownFromBlocks filters archive toolbar noise", () => {
    const blocks: ContentBlock[] = [
      {
        type: "text",
        tag: "table",
        text: "| archive.todaywebpage capture | Saved from | history←priornext→ |",
      },
      { type: "text", tag: "p", text: "Paragraf konten utama." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).not.toContain("archive.todaywebpage capture");
    expect(markdown).toContain("Paragraf konten utama.");
  });

  test("buildMarkdownFromBlocks filters archive history row noise", () => {
    const blocks: ContentBlock[] = [
      {
        type: "text",
        tag: "table",
        text: "| history←priornext→ |  |",
      },
      { type: "text", tag: "p", text: "Konten tetap ada." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).not.toContain("history←priornext→");
    expect(markdown).toContain("Konten tetap ada.");
  });

  test("buildMarkdownFromBlocks stops at related content section heading", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "p", text: "Paragraf utama satu." },
      { type: "text", tag: "h2", text: "Related Content" },
      { type: "text", tag: "p", text: "Paragraf sidebar yang harus dibuang." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain("Paragraf utama satu.");
    expect(markdown).not.toContain("Related Content");
    expect(markdown).not.toContain("Paragraf sidebar yang harus dibuang.");
  });

  test("buildMarkdownFromBlocks removes advertisement and blocked host noise", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "p", text: "Advertisement" },
      { type: "text", tag: "h2", text: "static01.nyt.com is blocked" },
      { type: "text", tag: "p", text: "Isi utama tetap ada." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain("Isi utama tetap ada.");
    expect(markdown).not.toContain("Advertisement");
    expect(markdown).not.toContain("static01.nyt.com is blocked");
  });

  test("buildMarkdownFromBlocks skips editors picks section but keeps next h2", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "h2", text: "Editors’ Picks" },
      { type: "text", tag: "h3", text: "Judul promo 1" },
      { type: "text", tag: "p", text: "Isi promo yang harus dibuang." },
      { type: "text", tag: "h2", text: "More on the Assault on Iran" },
      { type: "text", tag: "p", text: "Isi section relevan tetap tampil." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).not.toContain("Editors’ Picks");
    expect(markdown).not.toContain("Judul promo 1");
    expect(markdown).not.toContain("Isi promo yang harus dibuang.");
    expect(markdown).toContain("## More on the Assault on Iran");
    expect(markdown).toContain("Isi section relevan tetap tampil.");
  });

  test("buildMarkdownFromBlocks trims long leading image-only noise", () => {
    const blocks: ContentBlock[] = [
      {
        type: "image",
        src: "https://example.com/1.jpg",
        alt: "img",
        caption: "",
      },
      {
        type: "image",
        src: "https://example.com/2.jpg",
        alt: "img",
        caption: "",
      },
      {
        type: "image",
        src: "https://example.com/3.jpg",
        alt: "img",
        caption: "",
      },
      {
        type: "image",
        src: "https://example.com/4.jpg",
        alt: "img",
        caption: "",
      },
      { type: "text", tag: "p", text: "Isi utama artikel dimulai di sini." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain("Isi utama artikel dimulai di sini.");
    expect(markdown).not.toContain("https://example.com/1.jpg");
    expect(markdown).not.toContain("https://example.com/2.jpg");
    expect(markdown).not.toContain("https://example.com/3.jpg");
    expect(markdown).not.toContain("https://example.com/4.jpg");
  });

  test("buildMarkdownFromBlocks trims image run before first narrative text", () => {
    const blocks: ContentBlock[] = [
      { type: "text", tag: "h2", text: "Judul Section" },
      {
        type: "image",
        src: "https://example.com/a.jpg",
        alt: "img",
        caption: "",
      },
      {
        type: "image",
        src: "https://example.com/b.jpg",
        alt: "img",
        caption: "",
      },
      {
        type: "image",
        src: "https://example.com/c.jpg",
        alt: "img",
        caption: "",
      },
      { type: "text", tag: "p", text: "Paragraf naratif pertama." },
    ];

    const markdown = buildMarkdownFromBlocks(blocks);

    expect(markdown).toContain("## Judul Section");
    expect(markdown).toContain("Paragraf naratif pertama.");
    expect(markdown).not.toContain("https://example.com/a.jpg");
    expect(markdown).not.toContain("https://example.com/b.jpg");
    expect(markdown).not.toContain("https://example.com/c.jpg");
  });

  test("buildArticleText skips archive toolbar screenshot image", () => {
    const textOutput = buildArticleText(
      {
        url: "https://archive.is/abc/https://example.com/x",
        articleTitle: "Contoh Artikel",
        description: "",
        articleBodyText: "Isi utama.",
        contentBlocks: [
          {
            type: "image",
            src: "https://archive.is/abc/e50efde97512dae673ab464cf4d8e57946159199/scr.png",
            alt: "img",
            caption: "",
          },
          {
            type: "image",
            src: "https://archive.is/abc/real-photo.webp",
            alt: "foto",
            caption: "",
          },
        ],
        publishedAt: "2026-03-05T00:00:00.000Z",
      },
      "2026-03-07T00:00:00.000Z",
    );

    expect(textOutput).not.toContain("/scr.png");
    expect(textOutput).toContain("real-photo.webp");
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
    expect(textOutput).toContain(
      "![Gambar A](https://example.com/image-a.jpg)",
    );
    expect(textOutput).toContain("_Gambar 1: Caption A_");
  });
});
