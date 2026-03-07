import type { ContentBlock, ExtractedPage } from "./types";
import { unwrapArchiveProxyUrl } from "./archive-utils";
import { collectImagesFromBlocks } from "./image-utils";
import { extractStructuredArticleFromJsonLd } from "./structured-data";
import { normalizeScopedUrl } from "./url-utils";

type DomNode = {
  tagName?: string;
};

type CheerioCollection = {
  first(): CheerioCollection;
  text(): string;
  attr(name: string): string | undefined;
  each(callback: (index: number, element: unknown) => void): void;
  map<T>(callback: (index: number, element: unknown) => T): { get(): T[] };
  toArray(): unknown[];
  find(selector: string): CheerioCollection;
  closest(selector: string): CheerioCollection;
  remove(): void;
};

type CheerioApi = ((selector: string) => CheerioCollection) &
  ((element: unknown) => CheerioCollection);

const STOP_MARKERS = new Set(["discussion about this post", "ready for more?"]);

const NOISE_TEXTS = new Set([
  "subscribe",
  "sign in",
  "share",
  "comments",
  "restacks",
  "like",
  "likes",
  "masuk",
  "buat tulisan",
  "beranda",
  "tentang kami",
  "pedoman media siber",
  "ketentuan & kebijakan privasi",
  "panduan komunitas",
  "peringkat penulis",
  "cara menulis di kumparan",
  "informasi kerja sama",
  "bantuan",
  "iklan",
  "karir",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "whatsapp",
  "x",
  "topics",
  "sections",
  "more",
  "for ieee members",
  "ieee spectrum",
  "follow ieee spectrum",
  "support ieee spectrum",
]);

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function looksLikePageScriptNoise(text: string): boolean {
  const lowered = text.toLowerCase();
  const noiseMarkers = [
    "window.",
    "function(",
    "javascript",
    "datadog",
    "cloudflare",
    "json.parse(",
  ];

  return noiseMarkers.some((marker) => lowered.includes(marker));
}

function shouldSkipImage(src: string): boolean {
  const lowered = src.toLowerCase();

  return (
    lowered.startsWith("data:image/") ||
    lowered.endsWith(".svg") ||
    lowered.includes("/uikit-assets/assets/icons/") ||
    lowered.includes("/uikit-assets/assets/logos/") ||
    lowered.includes("/avatars/") ||
    lowered.includes("w_32,h_32") ||
    lowered.includes("w_36,h_36") ||
    lowered.includes("w_64,h_64")
  );
}

function shouldSkipText(text: string): boolean {
  const lowered = text.toLowerCase();

  return NOISE_TEXTS.has(lowered) || looksLikePageScriptNoise(lowered);
}

function looksLikeAuthorLabel(text: string): boolean {
  const compact = normalizeWhitespace(text);
  const words = compact.split(" ").filter(Boolean);

  if (words.length === 0 || words.length > 5) {
    return false;
  }

  return compact === compact.toUpperCase() && !compact.includes(".");
}

function tagNameOf(element: unknown): string {
  const node = element as DomNode;

  return (node.tagName ?? "").toLowerCase();
}

function extractArticleTitle($: CheerioApi, fallbackTitle: string): string {
  const readTexts = (selector: string): string[] =>
    $(selector)
      .map((_, element) => normalizeWhitespace($(element).text()))
      .get()
      .filter((text) => text.length > 0);

  const fromArticle = readTexts("article h1")[0];
  if (fromArticle) {
    return fromArticle;
  }

  const fromMain = readTexts("main h1")[0];
  if (fromMain) {
    return fromMain;
  }

  const allH1 = readTexts("h1");
  if (allH1.length > 0) {
    return [...allH1].sort((a, b) => b.length - a.length)[0] ?? fallbackTitle;
  }

  const fromOg = normalizeWhitespace(
    $("meta[property='og:title']").first().attr("content") ?? "",
  );
  if (fromOg) {
    return fromOg;
  }

  const fromTitleTag = normalizeWhitespace($("title").first().text());
  if (fromTitleTag) {
    return fromTitleTag;
  }

  return fallbackTitle;
}

function extractPublishedAt($: CheerioApi): string | null {
  const fromMeta = normalizeWhitespace(
    $("meta[property='article:published_time']").first().attr("content") ?? "",
  );

  if (fromMeta) {
    return fromMeta;
  }

  const fromTime = normalizeWhitespace(
    $("time").first().attr("datetime") ?? "",
  );

  return fromTime || null;
}

function pickContentRoot($: CheerioApi): CheerioCollection {
  const selectors = [
    "article",
    "main article",
    "[data-post-id]",
    ".available-content",
    "main",
    "body",
  ];

  let bestSelector = "body";
  let bestScore = -1;

  for (const selector of selectors) {
    const root = $(selector).first();
    const text = normalizeWhitespace(root.text());
    const paragraphCount = root.find("p").toArray().length;
    const score = paragraphCount * 200 + Math.min(text.length, 20000);

    if (score > bestScore) {
      bestScore = score;
      bestSelector = selector;
    }
  }

  return $(bestSelector).first();
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}

function buildMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width <= 0) {
    return "";
  }

  const normalizedRows = rows.map((row) => {
    const out = [...row];
    while (out.length < width) {
      out.push("");
    }
    return out;
  });

  const toLine = (row: string[]): string =>
    `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`;

  const header = normalizedRows[0] ?? [];
  const body = normalizedRows.slice(1);
  const separator = `| ${Array.from({ length: width }, () => ":---").join(" | ")} |`;

  return [toLine(header), separator, ...body.map(toLine)].join("\n");
}

function replaceFirstOccurrence(
  input: string,
  needle: string,
  replacement: string,
): string {
  if (!needle) {
    return input;
  }

  const index = input.indexOf(needle);
  if (index < 0) {
    return input;
  }

  return `${input.slice(0, index)}${replacement}${input.slice(index + needle.length)}`;
}

function normalizeInlineHref(
  href: string,
  currentPageUrl: URL,
  rootUrl: URL,
): string {
  const scoped = normalizeScopedUrl(href, currentPageUrl, rootUrl);
  if (scoped) {
    return unwrapArchiveProxyUrl(scoped);
  }

  try {
    return unwrapArchiveProxyUrl(new URL(href, currentPageUrl).toString());
  } catch {
    return href;
  }
}

function normalizeMediaSrc(src: string, currentPageUrl: URL): string {
  try {
    return new URL(src, currentPageUrl).toString();
  } catch {
    return src;
  }
}

function extractTextWithInlineFormatting(
  node: unknown,
  $: CheerioApi,
  currentPageUrl: URL,
  rootUrl: URL,
): string {
  let text = normalizeWhitespace($(node).text());
  if (!text) {
    return "";
  }

  const anchors = $(node).find("a[href]").toArray();
  for (const anchor of anchors) {
    const label = normalizeWhitespace($(anchor).text());
    const hrefRaw = normalizeWhitespace($(anchor).attr("href") ?? "");
    if (!label || !hrefRaw) {
      continue;
    }

    const href = normalizeInlineHref(hrefRaw, currentPageUrl, rootUrl);
    text = replaceFirstOccurrence(text, label, `[${label}](${href})`);
  }

  const inlineCodeNodes = $(node).find("code").toArray();
  for (const codeNode of inlineCodeNodes) {
    const codeText = normalizeWhitespace($(codeNode).text());
    if (!codeText) {
      continue;
    }

    text = replaceFirstOccurrence(text, codeText, `\`${codeText}\``);
  }

  return text;
}

function extractTableMarkdown(node: unknown, $: CheerioApi): string {
  const rows = $(node)
    .find("tr")
    .toArray()
    .map((row) => {
      return $(row)
        .find("th,td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text()));
    })
    .filter((cells) => cells.some((cell) => cell.length > 0));

  return buildMarkdownTable(rows);
}

function extractOrderedBlocks(
  root: CheerioCollection,
  $: CheerioApi,
  articleTitle: string,
  currentPageUrl: URL,
  rootUrl: URL,
): ContentBlock[] {
  const nodes = root
    .find("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table, hr, img")
    .toArray();
  const blocks: ContentBlock[] = [];

  for (const node of nodes) {
    const tagName = tagNameOf(node);

    if (!tagName) {
      continue;
    }

    const insideNavLike = $(node)
      .closest("nav, header, footer")
      .toArray().length;
    if (insideNavLike > 0) {
      continue;
    }

    if (tagName === "img") {
      const src =
        $(node).attr("src") ??
        $(node).attr("data-src") ??
        $(node).attr("srcset")?.split(",")[0]?.trim().split(" ")[0] ??
        "";

      if (!src || shouldSkipImage(src)) {
        continue;
      }

      const alt = normalizeWhitespace($(node).attr("alt") ?? "");
      blocks.push({
        type: "image",
        src: normalizeMediaSrc(src, currentPageUrl),
        alt,
        caption: "",
      });
      continue;
    }

    if (tagName === "table") {
      const tableMarkdown = extractTableMarkdown(node, $);
      if (!tableMarkdown) {
        continue;
      }
      blocks.push({
        type: "text",
        tag: "table",
        text: tableMarkdown,
      });
      continue;
    }

    if (tagName === "hr") {
      blocks.push({
        type: "text",
        tag: "hr",
        text: "------",
      });
      continue;
    }

    const text =
      tagName === "pre"
        ? $(node)
            .text()
            .replaceAll(/\u00a0/g, " ")
            .replaceAll(/\r\n/g, "\n")
            .trim()
        : extractTextWithInlineFormatting(node, $, currentPageUrl, rootUrl);

    if (!text || shouldSkipText(text)) {
      continue;
    }

    if (text === articleTitle) {
      continue;
    }

    if ((tagName === "h1" || tagName === "h2") && looksLikeAuthorLabel(text)) {
      continue;
    }

    if (STOP_MARKERS.has(text.toLowerCase())) {
      break;
    }

    blocks.push({
      type: "text",
      tag: tagName,
      text,
    });
  }

  return blocks;
}

export function extractPageFromHtml(
  url: string,
  html: string,
  rootUrl: URL,
  load: (htmlContent: string) => CheerioApi,
): ExtractedPage {
  const currentPageUrl = new URL(url);
  const $ = load(html);
  const jsonLdScripts = $("script[type='application/ld+json']")
    .map((_, element) => $(element).text())
    .get();

  $("script, style, noscript, iframe, svg").remove();

  const title = normalizeWhitespace($("title").first().text());
  const description = normalizeWhitespace(
    $("meta[name='description']").first().attr("content") ?? "",
  );

  const headings = $("h1, h2")
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter((heading) => heading.length > 0);

  const links: string[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");

    if (!href) {
      return;
    }

    const normalized = normalizeScopedUrl(href, currentPageUrl, rootUrl);

    if (normalized) {
      links.push(unwrapArchiveProxyUrl(normalized));
    }
  });

  const articleTitle = extractArticleTitle($, title);
  const publishedAt = extractPublishedAt($);
  const structured = extractStructuredArticleFromJsonLd(
    jsonLdScripts,
    articleTitle,
    description,
  );

  if (structured) {
    return {
      url,
      title,
      description: structured.description || description,
      headings,
      links: Array.from(new Set(links)),
      articleTitle: structured.articleTitle,
      articleBodyText: structured.articleBodyText,
      contentBlocks: structured.contentBlocks,
      images: collectImagesFromBlocks(structured.contentBlocks),
      imageCount: structured.imageCount,
      publishedAt: structured.publishedAt ?? publishedAt,
      isArticlePage: structured.articleBodyText.length > 160,
      markdownPath: null,
    };
  }

  const root = pickContentRoot($);
  const contentBlocks = extractOrderedBlocks(
    root,
    $,
    articleTitle,
    currentPageUrl,
    rootUrl,
  );

  const articleBodyText = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  const imageCount = contentBlocks.filter(
    (block) => block.type === "image",
  ).length;
  const images = collectImagesFromBlocks(contentBlocks);
  const isArticlePage =
    articleBodyText.length > 250 && !looksLikePageScriptNoise(articleBodyText);

  return {
    url,
    title,
    description,
    headings,
    links: Array.from(new Set(links)),
    articleTitle,
    articleBodyText,
    contentBlocks,
    images,
    imageCount,
    publishedAt,
    isArticlePage,
    markdownPath: null,
  };
}
