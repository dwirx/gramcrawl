import { describe, expect, test } from "bun:test";
import { extractPageWithJsdomFallback } from "./jsdom-fallback";

describe("extractPageWithJsdomFallback", () => {
  test("extracts readable article with title, links, and body", () => {
    const html = `
      <html>
        <head>
          <title>Halaman Uji</title>
          <meta name="description" content="Deskripsi uji artikel" />
          <meta property="article:published_time" content="2026-03-07T11:00:00Z" />
        </head>
        <body>
          <article>
            <h1>Judul Artikel Uji</h1>
            <p>Ini paragraf pertama yang cukup panjang untuk memastikan readability menganggap ini sebagai konten artikel utama, bukan sekadar navigasi.</p>
            <p>Ini paragraf kedua yang juga cukup panjang agar total karakter teks melewati ambang minimal ekstraksi dan hasil tetap stabil lintas engine parser.</p>
            <p>Lihat juga <a href="/world/update">tautan lanjutan</a> untuk detail lain.</p>
          </article>
        </body>
      </html>
    `;

    const extracted = extractPageWithJsdomFallback(
      "https://example.com/world/test",
      html,
      new URL("https://example.com/world/test"),
    );

    expect(extracted).not.toBeNull();
    if (!extracted) {
      throw new Error("Expected extracted page");
    }

    expect(extracted.articleTitle).toBe("Judul Artikel Uji");
    expect(extracted.description).toBe("Deskripsi uji artikel");
    expect(extracted.articleBodyText).toContain(
      "Ini paragraf pertama yang cukup panjang",
    );
    expect(extracted.links).toContain("https://example.com/world/update");
    expect(extracted.publishedAt).toBe("2026-03-07T11:00:00Z");
    expect(extracted.isArticlePage).toBeTrue();
  });
});
