import type { ContentBlock, ExtractedPage } from "./types";

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

const UI_NOISE_TEXTS = new Set([
  "subscribe",
  "sign in",
  "share",
  "comments",
  "restacks",
  "like",
  "likes",
  "toplatestdiscussions",
  "see all",
  "ready for more?",
  "skip to content",
  "support us",
  "unduh data",
  "bagikan tautan",
  "pilihan editor",
  "search",
  "cari",
  "search cari",
  "search search",
  "jadi kawan m",
  "proyeksengsaranasional",
]);

const STOP_MARKERS = [
  "discussion about this post",
  "ready for more?",
  "toplatestdiscussions",
  "temukan kumpulan riset terkait",
  "see all",
  "berikut sebaran masalahnya",
];

const IMAGE_NOISE_SRC_MARKERS = [
  "cdn.userway.org",
  "/quote-1.svg",
  "/logo-",
  "logo-",
  "/avatars/",
  "spin_wh.svg",
  "body_wh.svg",
];

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
    `# ${page.articleTitle}`,
    "",
    `Source: ${page.url}`,
    "",
  ];

  if (page.description) {
    lines.push(`_${page.description}_`, "", "* * *", "");
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
  const bodyText = buildTextFromBlocks(
    page.contentBlocks,
    page.articleBodyText,
  );

  return [
    "================================================================================",
    `TITLE: ${page.articleTitle}`,
    `SOURCE: ${page.url}`,
    `DATE: ${displayDate}`,
    "================================================================================",
    "",
    ...(page.description ? [`_${page.description}_`, "", "* * *", ""] : []),
    bodyText,
    "",
  ].join("\n");
}

export function buildMarkdownFromBlocks(blocks: ContentBlock[]): string {
  const filteredBlocks = filterRenderableBlocks(blocks);
  const lines: string[] = [];

  let imageIndex = 0;
  for (const block of filteredBlocks) {
    if (block.type === "text") {
      renderTextBlockMarkdown(lines, block.tag, block.text);
      continue;
    }

    imageIndex += 1;
    const alt = normalizeWhitespace(block.alt) || "img";
    const caption = normalizeWhitespace(block.caption);

    lines.push(`![${alt}](${block.src})`, "");
    if (caption) {
      lines.push(
        `_Gambar ${imageIndex}: ${formatCaptionMarkdown(caption)}_`,
        "",
      );
    }
  }

  return lines.join("\n").trim();
}

function renderTextBlockMarkdown(
  lines: string[],
  tag: string,
  rawText: string,
): void {
  const normalizedTag = tag.toLowerCase();
  if (normalizedTag === "table") {
    const tableBlock = rawText.replaceAll(/\r\n/g, "\n").trim();
    if (!tableBlock) {
      return;
    }
    lines.push(tableBlock, "");
    return;
  }

  if (normalizedTag === "hr") {
    lines.push("------", "");
    return;
  }

  if (normalizedTag === "pre") {
    const codeBlock = rawText.replaceAll(/\r\n/g, "\n").trim();
    if (!codeBlock) {
      return;
    }
    const fence = codeBlock.includes("```") ? "````" : "```";
    lines.push(fence, codeBlock, fence, "");
    return;
  }

  const normalized = normalizeWhitespace(rawText);
  if (!normalized) {
    return;
  }

  if (/^h[1-6]$/.test(normalizedTag)) {
    const level = Number(normalizedTag[1] ?? "2");
    const headingLevel = Math.max(2, Math.min(6, level));
    lines.push(`${"#".repeat(headingLevel)} ${normalized}`, "");
    return;
  }

  if (normalizedTag === "blockquote") {
    const quoteLines = normalized
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    if (quoteLines.length > 0) {
      lines.push(...quoteLines.map((line) => `> ${line}`), "");
    }
    return;
  }

  if (normalizedTag === "li") {
    lines.push(`- ${normalized}`, "");
    return;
  }

  lines.push(normalized, "");
}

function buildTextFromBlocks(
  blocks: ContentBlock[],
  fallbackBody: string,
): string {
  const filteredBlocks = filterRenderableBlocks(blocks);

  if (filteredBlocks.length === 0) {
    return fallbackBody;
  }

  const lines: string[] = [];
  let imageIndex = 0;

  for (const block of filteredBlocks) {
    if (block.type === "text") {
      renderTextBlockMarkdown(lines, block.tag, block.text);
      continue;
    }

    imageIndex += 1;
    const src = normalizeWhitespace(block.src) || "image";
    const alt = normalizeWhitespace(block.alt) || "img";
    const caption = normalizeWhitespace(block.caption);

    lines.push(`![${alt}](${src})`);
    if (caption) {
      lines.push(`_Gambar ${imageIndex}: ${caption}_`);
    }
    lines.push("");
  }

  const built = lines.join("\n").trim();
  return built || fallbackBody;
}

function filterRenderableBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const filtered: ContentBlock[] = [];
  let previousTextKey = "";
  let shouldStop = false;
  const seenLongTextKeys = new Set<string>();

  for (const block of blocks) {
    if (shouldStop) {
      break;
    }

    if (block.type === "text") {
      const normalizedTag = block.tag.toLowerCase();
      const isPreformatted =
        normalizedTag === "pre" || normalizedTag === "table";
      const text = isPreformatted
        ? block.text.replaceAll(/\r\n/g, "\n").trim()
        : normalizeWhitespace(block.text);
      if (!text || isUiNoiseLine(text)) {
        continue;
      }

      const key = normalizeForNoise(text);
      if (STOP_MARKERS.some((marker) => key.includes(marker))) {
        shouldStop = true;
        continue;
      }

      if (key.length >= 24 && seenLongTextKeys.has(key)) {
        continue;
      }
      if (key.length >= 24) {
        seenLongTextKeys.add(key);
      }

      if (key === previousTextKey) {
        continue;
      }

      previousTextKey = key;
      filtered.push({ ...block, text });
      continue;
    }

    previousTextKey = "";
    if (shouldSkipImageInOutput(block.src, block.alt, block.caption)) {
      continue;
    }
    filtered.push({
      ...block,
      src: normalizeWhitespace(block.src),
      alt: normalizeWhitespace(block.alt),
      caption: normalizeWhitespace(block.caption),
    });
  }

  return filtered;
}

function isUiNoiseLine(text: string): boolean {
  const lowered = normalizeForNoise(text);
  if (UI_NOISE_TEXTS.has(lowered)) {
    return true;
  }

  if (lowered.startsWith("© ")) {
    return true;
  }

  if (/^(\*+\s*)?(en|id|home|menu)(\s*\*+)?$/i.test(lowered)) {
    return true;
  }

  if (lowered.includes("made with flourish")) {
    return true;
  }

  if (
    lowered.includes("create a chart") ||
    lowered.includes("create a hierarchy graph") ||
    lowered.includes("create a pictogram chart")
  ) {
    return true;
  }

  return /^(artikel|reportase|ide & esai|multimedia|cerita foto|video|siniar|serial|tentang kami)(\s+\*?\s*(artikel|reportase|ide & esai|multimedia|cerita foto|video|siniar|serial|tentang kami))*$/i.test(
    lowered.replaceAll(/\*/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
}

function shouldSkipImageInOutput(
  srcValue: string,
  altValue: string,
  captionValue: string,
): boolean {
  const src = normalizeWhitespace(srcValue).toLowerCase();
  const alt = normalizeWhitespace(altValue).toLowerCase();
  const caption = normalizeWhitespace(captionValue).toLowerCase();

  if (!src) {
    return true;
  }

  if (src.endsWith(".svg")) {
    return true;
  }

  if (IMAGE_NOISE_SRC_MARKERS.some((marker) => src.includes(marker))) {
    return true;
  }

  if (/^image\s*\d+/i.test(alt)) {
    return true;
  }

  if (caption && /^https?:\/\/[^/]+\/?$/i.test(caption)) {
    return true;
  }

  return false;
}

function formatCaptionMarkdown(caption: string): string {
  if (/^https?:\/\//i.test(caption)) {
    return `[Sumber gambar](${caption})`;
  }

  return caption;
}

function normalizeForNoise(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replaceAll(/\*|_|`|#|>|\[|\]|\(|\)/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}
