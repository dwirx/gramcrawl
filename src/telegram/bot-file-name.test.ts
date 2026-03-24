import { mkdir, rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { buildSendFileNameForExtract } from "./handlers/file-utils";

describe("buildSendFileNameForExtract", () => {
  test("keeps original basename for non-latest files", async () => {
    const fileName = await buildSendFileNameForExtract(
      "/tmp/teleextract/non-latest/article.md",
      "markdown",
    );

    expect(fileName).toBe("article.md");
  });

  test("uses articleTitle from latest.json for latest files", async () => {
    const rootDir = `/tmp/teleextract-send-name-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const articleDir = `${rootDir}/sites/example.com/sample-article`;

    await mkdir(articleDir, { recursive: true });
    await Bun.write(
      `${articleDir}/latest.json`,
      `${JSON.stringify({ articleTitle: 'Judul: Analisis / Uji ? "Keren"' })}\n`,
    );

    try {
      const fileName = await buildSendFileNameForExtract(
        `${articleDir}/latest.md`,
        "markdown",
      );

      expect(fileName).toBe("Judul Analisis Uji Keren.md");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to article slug when latest.json is missing", async () => {
    const fileName = await buildSendFileNameForExtract(
      "/tmp/teleextract/sites/example.com/analysis-suggests-school/latest.txt",
      "text",
    );

    expect(fileName).toBe("analysis-suggests-school.txt");
  });
});
