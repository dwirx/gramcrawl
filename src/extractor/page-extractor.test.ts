import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import { extractPageFromHtml } from "./page-extractor";

describe("extractPageFromHtml", () => {
  test("prefers article heading over navbar heading for articleTitle", () => {
    const html = [
      "<html><head><title>CLI vs MCP</title></head><body>",
      "<nav><h1>Kan Yilmaz</h1></nav>",
      "<section>",
      "<h1>I Made MCP 94% Cheaper (And It Only Took One Command)</h1>",
      "<p>Paragraph one for article body.</p>",
      "<p>Paragraph two for article body.</p>",
      "</section>",
      "</body></html>",
    ].join("");

    const loadAdapter = (content: string) => load(content) as never;

    const extracted = extractPageFromHtml(
      "https://kanyilmaz.me/2026/02/23/cli-vs-mcp.html",
      html,
      new URL("https://kanyilmaz.me/"),
      loadAdapter,
    );

    expect(extracted.articleTitle).toBe(
      "I Made MCP 94% Cheaper (And It Only Took One Command)",
    );
    expect(
      extracted.contentBlocks.some((item) => {
        return item.type === "text" && item.text === "Kan Yilmaz";
      }),
    ).toBeFalse();
  });

  test("keeps inline links, inline code, and hr in extracted blocks", () => {
    const html = [
      "<html><head><title>Sample</title></head><body>",
      "<main>",
      "<h1>Sample Article</h1>",
      "<p>Open sourced the converter - <a href='https://github.com/thellimist/clihub'>one command</a> to create CLIs.</p>",
      "<p>I like using formatting of Openclaw's <a href='https://github.com/openclaw/openclaw/docs'><code>available_skills</code> block</a>.</p>",
      "<hr />",
      "</main>",
      "</body></html>",
    ].join("");

    const loadAdapter = (content: string) => load(content) as never;
    const extracted = extractPageFromHtml(
      "https://kanyilmaz.me/2026/02/23/cli-vs-mcp.html",
      html,
      new URL("https://kanyilmaz.me/"),
      loadAdapter,
    );

    const texts = extracted.contentBlocks
      .filter((item) => item.type === "text")
      .map((item) => item.text);

    expect(
      texts.some((text) =>
        text.includes("[one command](https://github.com/thellimist/clihub)"),
      ),
    ).toBeTrue();
    expect(
      texts.some((text) =>
        text.includes(
          "[`available_skills` block](https://github.com/openclaw/openclaw/docs)",
        ),
      ),
    ).toBeTrue();
    expect(texts).toContain("------");
  });

  test("normalizes relative image src to absolute url", () => {
    const html = [
      "<html><head><title>Img</title></head><body>",
      "<main>",
      "<h1>Image Test</h1>",
      "<img src='/assets/posts/cli_vs_mcp.png' alt='img' />",
      "<p>Body text here.</p>",
      "</main>",
      "</body></html>",
    ].join("");

    const loadAdapter = (content: string) => load(content) as never;
    const extracted = extractPageFromHtml(
      "https://kanyilmaz.me/2026/02/23/cli-vs-mcp.html",
      html,
      new URL("https://kanyilmaz.me/"),
      loadAdapter,
    );

    const image = extracted.contentBlocks.find((item) => item.type === "image");
    expect(image).not.toBeUndefined();
    if (!image || image.type !== "image") {
      return;
    }
    expect(image.src).toBe("https://kanyilmaz.me/assets/posts/cli_vs_mcp.png");
  });
});
