import type { ContentBlock, ExtractedPage } from "./types";

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function toDisplayDate(rawDate: string): string {
  const date = new Date(rawDate);

  if (Number.isNaN(date.getTime())) {
    return rawDate;
  }

  return date.toLocaleString("en-US");
}

export function slugifyTitle(title: string): string {
  const normalized = normalizeWhitespace(title)
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return normalized || "untitled-article";
}

export function buildArticleMarkdown(
  page: Pick<
    ExtractedPage,
    | "url"
    | "articleTitle"
    | "description"
    | "articleBodyText"
    | "contentBlocks"
    | "publishedAt"
  >,
  collectedAt: string,
): string {
  const displayDate = toDisplayDate(page.publishedAt ?? collectedAt);
  const lines: string[] = [
    "================================================================================",
    `TITLE: ${page.articleTitle}`,
    `SOURCE: ${page.url}`,
    `DATE: ${displayDate}`,
    "================================================================================",
    "",
    "---",
    `title: ${JSON.stringify(page.articleTitle)}`,
    `source: ${JSON.stringify(page.url)}`,
    `publishedAt: ${JSON.stringify(page.publishedAt)}`,
    `collectedAt: ${JSON.stringify(collectedAt)}`,
    "---",
    "",
    `# ${page.articleTitle}`,
    "",
    `Source: [${page.url}](${page.url})`,
    "",
  ];

  if (page.description) {
    lines.push(`> ${page.description}`, "");
  }

  const bodyMarkdown = buildMarkdownFromBlocks(page.contentBlocks);

  if (bodyMarkdown) {
    lines.push(bodyMarkdown);
  } else {
    for (const paragraph of page.articleBodyText.split("\n\n")) {
      const cleaned = normalizeWhitespace(paragraph);

      if (cleaned) {
        lines.push(cleaned, "");
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildArticleText(
  page: Pick<
    ExtractedPage,
    "url" | "articleTitle" | "articleBodyText" | "publishedAt"
  >,
  collectedAt: string,
): string {
  const displayDate = toDisplayDate(page.publishedAt ?? collectedAt);

  return [
    "================================================================================",
    `TITLE: ${page.articleTitle}`,
    `SOURCE: ${page.url}`,
    `DATE: ${displayDate}`,
    "================================================================================",
    "",
    page.articleBodyText,
    "",
  ].join("\n");
}

export function buildMarkdownFromBlocks(blocks: ContentBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      const text = normalizeWhitespace(block.text);

      if (text) {
        lines.push(text, "");
      }
      continue;
    }

    const alt = normalizeWhitespace(block.alt) || "image";
    const caption = normalizeWhitespace(block.caption);

    lines.push(`![${alt}](${block.src})`, "");
    if (caption) {
      lines.push(`*${caption}*`, "");
    }
  }

  return lines.join("\n").trim();
}
