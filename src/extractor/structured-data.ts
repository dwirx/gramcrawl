import type { ContentBlock } from "./types";

export type StructuredArticle = {
  articleTitle: string;
  description: string;
  articleBodyText: string;
  contentBlocks: ContentBlock[];
  imageCount: number;
  publishedAt: string | null;
};

type JsonLdImage =
  | string
  | {
      url?: string;
    };

type JsonLdArticle = {
  "@type"?: string | string[];
  headline?: string;
  description?: string;
  articleBody?: string;
  datePublished?: string;
  image?: JsonLdImage | JsonLdImage[];
};

function normalizeWhitespace(value: string): string {
  return value
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/\u00a0/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function typeMatchesArticle(rawType: string | string[] | undefined): boolean {
  if (!rawType) {
    return false;
  }

  const types = Array.isArray(rawType) ? rawType : [rawType];
  return types.some((item) => /article|newsarticle|blogposting/i.test(item));
}

function splitParagraphs(articleBody: string): string[] {
  return articleBody
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

function readImageUrls(image: JsonLdArticle["image"]): string[] {
  if (!image) {
    return [];
  }

  const list = Array.isArray(image) ? image : [image];
  const urls = list
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      return item.url;
    })
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(urls));
}

function parseJsonLdBlock(rawJson: string): JsonLdArticle[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;

    if (Array.isArray(parsed)) {
      return parsed as JsonLdArticle[];
    }

    if (parsed && typeof parsed === "object") {
      return [parsed as JsonLdArticle];
    }

    return [];
  } catch {
    return [];
  }
}

export function extractStructuredArticleFromJsonLd(
  jsonLdScripts: string[],
  fallbackTitle: string,
  fallbackDescription: string,
): StructuredArticle | null {
  const objects = jsonLdScripts.flatMap(parseJsonLdBlock);

  let candidate: JsonLdArticle | null = null;
  for (const item of objects) {
    if (!typeMatchesArticle(item["@type"])) {
      continue;
    }

    const body = normalizeWhitespace(item.articleBody ?? "");

    if (body.length < 10) {
      continue;
    }

    candidate = item;
    break;
  }

  if (!candidate) {
    return null;
  }

  const articleTitle =
    normalizeWhitespace(candidate.headline ?? "") || fallbackTitle;
  const description =
    normalizeWhitespace(candidate.description ?? "") || fallbackDescription;
  const paragraphs = splitParagraphs(candidate.articleBody ?? "");

  if (paragraphs.length === 0) {
    return null;
  }

  const imageUrls = readImageUrls(candidate.image);

  const textBlocks: ContentBlock[] = paragraphs.map((text) => ({
    type: "text",
    tag: "p",
    text,
  }));

  const imageBlocks: ContentBlock[] = imageUrls.map((src) => ({
    type: "image",
    src,
    alt: "image",
    caption: "",
  }));

  return {
    articleTitle,
    description,
    articleBodyText: paragraphs.join("\n\n"),
    contentBlocks: [...textBlocks, ...imageBlocks],
    imageCount: imageBlocks.length,
    publishedAt: candidate.datePublished ?? null,
  };
}
