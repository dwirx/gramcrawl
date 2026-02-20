import type { ContentBlock, ExtractedPage } from "./types";
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
  const candidates = [
    "article h1",
    "main h1",
    "h1",
    "meta[property='og:title']",
    "title",
  ];

  for (const selector of candidates) {
    const value = selector.startsWith("meta[")
      ? normalizeWhitespace($(selector).first().attr("content") ?? "")
      : normalizeWhitespace($(selector).first().text());

    if (value) {
      return value;
    }
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

function extractOrderedBlocks(
  root: CheerioCollection,
  $: CheerioApi,
  articleTitle: string,
): ContentBlock[] {
  const nodes = root
    .find("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, img")
    .toArray();
  const blocks: ContentBlock[] = [];

  for (const node of nodes) {
    const tagName = tagNameOf(node);

    if (!tagName) {
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
        src,
        alt,
        caption: alt,
      });
      continue;
    }

    const text = normalizeWhitespace($(node).text());

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
      links.push(normalized);
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
      imageCount: structured.imageCount,
      publishedAt: structured.publishedAt ?? publishedAt,
      isArticlePage: structured.articleBodyText.length > 160,
      markdownPath: null,
    };
  }

  const root = pickContentRoot($);
  const contentBlocks = extractOrderedBlocks(root, $, articleTitle);

  const articleBodyText = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  const imageCount = contentBlocks.filter(
    (block) => block.type === "image",
  ).length;
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
    imageCount,
    publishedAt,
    isArticlePage,
    markdownPath: null,
  };
}
