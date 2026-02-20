import { loadCheerioModule } from "./cheerio-loader";
import { extractPageFromHtml } from "./page-extractor";
import {
  fetchRenderedFallbackArticle,
  type RenderedFallbackArticle,
} from "./rendered-fallback";
import type { ExtractionResult, ExtractedPage } from "./types";

function readCookieOverride(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const globalCookie = process.env.EXTRACT_COOKIE?.trim() ?? "";
  const mappedRaw = process.env.EXTRACT_COOKIE_MAP?.trim() ?? "";

  if (!mappedRaw) {
    return globalCookie;
  }

  try {
    const mapped = JSON.parse(mappedRaw) as Record<string, string>;
    const exact = mapped[host]?.trim();

    if (exact) {
      return exact;
    }

    const wildcard = Object.entries(mapped).find(([domain]) =>
      host.endsWith(domain.replace(/^\*\./, "")),
    )?.[1];

    return wildcard?.trim() || globalCookie;
  } catch {
    return globalCookie;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const cookie = readCookieOverride(url);
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,id;q=0.8",
        "cache-control": "no-cache",
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

function buildExtractedPageFromRenderedFallback(
  url: string,
  fallback: RenderedFallbackArticle,
): ExtractedPage {
  return {
    url,
    title: fallback.articleTitle,
    description: fallback.description,
    headings: [fallback.articleTitle],
    links: [],
    articleTitle: fallback.articleTitle,
    articleBodyText: fallback.articleBodyText,
    contentBlocks: fallback.contentBlocks,
    imageCount: fallback.imageCount,
    publishedAt: fallback.publishedAt,
    isArticlePage: fallback.articleBodyText.length > 80,
    markdownPath: null,
  };
}

function shouldQueueLink(candidateUrl: string, rootUrl: URL): boolean {
  const candidate = new URL(candidateUrl);

  if (candidate.origin !== rootUrl.origin) {
    return false;
  }

  const rootPath = rootUrl.pathname;

  if (rootPath === "/docs" || rootPath.startsWith("/docs/")) {
    return (
      candidate.pathname === "/docs" || candidate.pathname.startsWith("/docs/")
    );
  }

  if (rootPath.includes("/post/") || /\/p-\d+/.test(rootPath)) {
    return candidate.pathname === rootPath;
  }

  return true;
}

function looksLikeBlockedPage(
  page: Pick<ExtractedPage, "title" | "articleBodyText">,
): boolean {
  const combined = `${page.title}\n${page.articleBodyText}`.toLowerCase();
  const markers = [
    "just a moment",
    "security verification",
    "verify you are not a bot",
    "access denied",
    "forbidden",
    "captcha",
    "cloudflare",
  ];

  return markers.some((marker) => combined.includes(marker));
}

function buildBlockedError(url: string): Error {
  return new Error(
    [
      `Gagal mengambil ${url} (blocked/no readable content).`,
      "Kemungkinan website memakai anti-bot (Cloudflare/CAPTCHA).",
      "Solusi: set cookie browser di .env:",
      "EXTRACT_COOKIE='cf_clearance=...; ...'",
      "atau domain map:",
      `EXTRACT_COOKIE_MAP='{"projectmultatuli.org":"cf_clearance=...; ..."}'`,
    ].join(" "),
  );
}

async function fetchMediumProviderHtml(url: string): Promise<string | null> {
  const hostname = new URL(url).hostname.toLowerCase();
  const isMediumHost =
    hostname === "medium.com" || hostname.endsWith(".medium.com");

  if (!isMediumHost) {
    return null;
  }

  try {
    const response = await fetch(`https://freedium.cfd/${url}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

export async function crawlCheerioDocs(
  rootUrl: string,
  maxPages: number,
): Promise<ExtractionResult> {
  const scopedRootUrl = new URL(rootUrl);

  const cheerio = await loadCheerioModule();

  const queue: string[] = [scopedRootUrl.toString()];
  const visited = new Set<string>();
  const pages: ExtractedPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    try {
      const html = await fetchHtml(currentUrl);
      let extracted: ExtractedPage | null = null;

      if (html) {
        extracted = extractPageFromHtml(
          currentUrl,
          html,
          scopedRootUrl,
          cheerio.load,
        );
      }

      const blockedByChallenge = extracted
        ? looksLikeBlockedPage(extracted)
        : false;

      if (
        !extracted ||
        extracted.articleBodyText.length < 160 ||
        blockedByChallenge
      ) {
        const fallback = await fetchRenderedFallbackArticle(currentUrl);

        if (!extracted && fallback) {
          extracted = buildExtractedPageFromRenderedFallback(
            currentUrl,
            fallback,
          );
        } else if (
          extracted &&
          fallback &&
          fallback.articleBodyText.length > extracted.articleBodyText.length
        ) {
          extracted.articleTitle =
            fallback.articleTitle || extracted.articleTitle;
          extracted.description = fallback.description || extracted.description;
          extracted.articleBodyText = fallback.articleBodyText;
          extracted.contentBlocks = fallback.contentBlocks;
          extracted.imageCount = fallback.imageCount;
          extracted.publishedAt = fallback.publishedAt ?? extracted.publishedAt;
          extracted.isArticlePage = fallback.articleBodyText.length > 80;
        }
      }

      const stillBlocked = extracted ? looksLikeBlockedPage(extracted) : false;

      if (!extracted || stillBlocked) {
        const mediumProviderHtml = await fetchMediumProviderHtml(currentUrl);

        if (mediumProviderHtml) {
          const mediumExtracted = extractPageFromHtml(
            currentUrl,
            mediumProviderHtml,
            scopedRootUrl,
            cheerio.load,
          );

          if (
            !looksLikeBlockedPage(mediumExtracted) &&
            mediumExtracted.articleBodyText.length > 160
          ) {
            extracted = mediumExtracted;
          }
        }
      }

      if (!extracted || looksLikeBlockedPage(extracted)) {
        throw buildBlockedError(currentUrl);
      }

      pages.push(extracted);

      for (const link of extracted.links) {
        if (!visited.has(link) && shouldQueueLink(link, scopedRootUrl)) {
          queue.push(link);
        }
      }
    } catch {
      if (pages.length === 0) {
        throw buildBlockedError(currentUrl);
      }
      continue;
    }
  }

  return {
    rootUrl: scopedRootUrl.toString(),
    maxPages,
    crawledPages: pages.length,
    collectedAt: new Date().toISOString(),
    pages,
  };
}
