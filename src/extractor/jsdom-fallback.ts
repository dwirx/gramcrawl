import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { collectImagesFromBlocks } from "./image-utils";
import type { ContentBlock, ExtractedPage } from "./types";
import { normalizeScopedUrl } from "./url-utils";

const MIN_ARTICLE_BODY_LENGTH = 160;
const MAX_BLOCKS = 500;

type DomElementLike = {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  remove(): void;
};

type DomDocumentLike = {
  title: string;
  querySelector(selector: string): DomElementLike | null;
  querySelectorAll(selector: string): Iterable<DomElementLike>;
};

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function toAbsoluteUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractPublishedAt(document: DomDocumentLike): string | null {
  const selectors = [
    "meta[property='article:published_time']",
    "meta[name='publish-date']",
    "meta[name='date']",
    "time[datetime]",
  ];

  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (!found) {
      continue;
    }

    const metaContent = found.getAttribute("content");
    const timeValue = found.getAttribute("datetime");
    const value = normalizeWhitespace(metaContent ?? timeValue ?? "");
    if (value) {
      return value;
    }
  }

  return null;
}

function extractDescription(
  document: DomDocumentLike,
  fallback: string,
): string {
  const metaDescription = normalizeWhitespace(
    document
      .querySelector("meta[name='description']")
      ?.getAttribute("content") ?? "",
  );
  if (metaDescription) {
    return metaDescription;
  }

  return normalizeWhitespace(fallback);
}

function blocksFromReadableHtml(
  contentHtml: string,
  baseUrl: string,
): ContentBlock[] {
  if (!contentHtml.trim()) {
    return [];
  }

  const contentDom = new JSDOM(`<main>${contentHtml}</main>`, {
    url: baseUrl,
  });

  try {
    const blocks: ContentBlock[] = [];
    const nodes = contentDom.window.document.querySelectorAll(
      "h1, h2, h3, p, li, blockquote, pre, img, figcaption",
    );

    for (const node of nodes) {
      if (blocks.length >= MAX_BLOCKS) {
        break;
      }

      if (node.tagName.toLowerCase() === "img") {
        const src = toAbsoluteUrl(node.getAttribute("src") ?? "", baseUrl);
        if (!src) {
          continue;
        }

        blocks.push({
          type: "image",
          src,
          alt: normalizeWhitespace(node.getAttribute("alt") ?? ""),
          caption: "",
        });
        continue;
      }

      const text = normalizeWhitespace(node.textContent ?? "");
      if (!text) {
        continue;
      }

      blocks.push({
        type: "text",
        tag: node.tagName.toLowerCase(),
        text,
      });
    }

    return blocks;
  } finally {
    contentDom.window.close();
  }
}

function buildArticleBodyText(
  blocks: ContentBlock[],
  fallback: string,
): string {
  const fromBlocks = blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();

  if (fromBlocks.length >= MIN_ARTICLE_BODY_LENGTH) {
    return fromBlocks;
  }

  return normalizeWhitespace(fallback);
}

function extractScopedLinks(
  document: DomDocumentLike,
  currentUrl: URL,
  rootUrl: URL,
): string[] {
  const links: string[] = [];
  const anchors = Array.from(document.querySelectorAll("a[href]"));

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }

    const normalized = normalizeScopedUrl(href, currentUrl, rootUrl);
    if (normalized) {
      links.push(normalized);
    }
  }

  return Array.from(new Set(links));
}

export function extractPageWithJsdomFallback(
  url: string,
  html: string,
  rootUrl: URL,
): ExtractedPage | null {
  const dom = new JSDOM(html, { url });

  try {
    const document = dom.window.document;
    document
      .querySelectorAll("script, style, noscript, iframe, svg")
      .forEach((node: { remove: () => void }) => node.remove());

    const parsed = new Readability(document).parse();
    if (!parsed) {
      return null;
    }

    const articleText = normalizeWhitespace(parsed.textContent ?? "");

    if (articleText.length < MIN_ARTICLE_BODY_LENGTH) {
      return null;
    }

    const contentBlocks = blocksFromReadableHtml(parsed.content ?? "", url);
    const firstHeadingFromContent = contentBlocks.find(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text" &&
        (block.tag === "h1" || block.tag === "h2" || block.tag === "h3"),
    )?.text;
    const articleTitle = normalizeWhitespace(
      firstHeadingFromContent ?? parsed.title ?? "",
    );
    if (!articleTitle) {
      return null;
    }

    const articleBodyText = buildArticleBodyText(contentBlocks, articleText);
    if (articleBodyText.length < MIN_ARTICLE_BODY_LENGTH) {
      return null;
    }

    const title =
      normalizeWhitespace(document.querySelector("title")?.textContent ?? "") ||
      articleTitle;
    const description = extractDescription(document, parsed.excerpt ?? "");
    const headings = Array.from(
      new Set(
        contentBlocks
          .filter(
            (block): block is Extract<ContentBlock, { type: "text" }> =>
              block.type === "text" &&
              (block.tag === "h1" || block.tag === "h2" || block.tag === "h3"),
          )
          .map((block) => block.text)
          .filter((value) => value.length > 0),
      ),
    );

    const currentUrl = new URL(url);
    const links = extractScopedLinks(document, currentUrl, rootUrl);

    return {
      url,
      title,
      description,
      headings,
      links,
      articleTitle,
      articleBodyText,
      contentBlocks,
      images: collectImagesFromBlocks(contentBlocks),
      imageCount: contentBlocks.filter((block) => block.type === "image")
        .length,
      publishedAt: extractPublishedAt(document),
      isArticlePage: articleBodyText.length > MIN_ARTICLE_BODY_LENGTH,
      markdownPath: null,
    };
  } catch {
    return null;
  } finally {
    dom.window.close();
  }
}
