import { describe, expect, test } from "bun:test";
import {
  buildArticleOutputFileNames,
  buildDefuddleFetchUrl,
  parseDefuddleTitleFromMarkdown,
} from "./service";

describe("defuddle helpers", () => {
  test("builds defuddle endpoint by stripping protocol", () => {
    const endpoint = buildDefuddleFetchUrl("https://example.com/article");
    expect(endpoint).toBe("https://defuddle.md/example.com/article");
  });

  test("extracts title from yaml frontmatter", () => {
    const markdown = [
      "---",
      'title: "Hello World"',
      'source: "https://example.com"',
      "---",
      "",
      "Body text.",
    ].join("\n");

    expect(parseDefuddleTitleFromMarkdown(markdown)).toBe("Hello World");
  });

  test("returns null when frontmatter title does not exist", () => {
    const markdown = ["# Heading", "", "Body text."].join("\n");
    expect(parseDefuddleTitleFromMarkdown(markdown)).toBeNull();
  });

  test("builds article file names using title slug", () => {
    const names = buildArticleOutputFileNames("The Insane Stupidity of UBI");
    expect(names.markdownFileName).toBe("the-insane-stupidity-of-ubi.md");
    expect(names.textFileName).toBe("the-insane-stupidity-of-ubi.txt");
    expect(names.metaFileName).toBe("the-insane-stupidity-of-ubi.json");
  });
});
