import {
  fetchBrowserFallbackHtml,
  isBrowserFallbackForced,
} from "./browser-fallback";
import { extractArchiveOriginalUrl } from "./archive-utils";
import { loadCheerioModule } from "./cheerio-loader";
import { collectImagesFromBlocks } from "./image-utils";
import { extractPageWithJsdomFallback } from "./jsdom-fallback";
import { extractPageFromHtml } from "./page-extractor";
import {
  fetchRenderedFallbackArticle,
  type RenderedFallbackArticle,
} from "./rendered-fallback";
import type { ExtractionResult, ExtractedPage } from "./types";

export type CrawlProgress = {
  step: "page-start" | "page-done" | "page-failed";
  url: string;
  crawledPages: number;
  queueLength: number;
  maxPages: number;
  message: string;
};

export type CrawlOptions = {
  onProgress?: (progress: CrawlProgress) => Promise<void> | void;
  shouldCancel?: () => boolean;
  signal?: AbortSignal;
};

const AUTO_BROWSER_FALLBACK_HOSTS = ["nytimes.com", "bloomberg.com"];
const QUEUE_LIMIT_MULTIPLIER = 25;
const MIN_QUEUE_LIMIT = 60;
const MAX_LINKS_SCANNED_PER_PAGE = 400;
const FETCH_TIMEOUT_MS = 20_000;

function isCancelled(options?: CrawlOptions): boolean {
  return Boolean(options?.shouldCancel?.() || options?.signal?.aborted);
}

function throwIfCancelled(options?: CrawlOptions): void {
  if (isCancelled(options)) {
    throw new Error("Extraction cancelled by user");
  }
}

function isCancellationError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      error.name === "AbortError" ||
      message.includes("cancelled by user") ||
      message.includes("aborted")
    );
  }
  return false;
}

function createRequestSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timeout (${timeoutMs}ms)`));
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason ?? new Error("Aborted"));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

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

async function fetchHtml(
  url: string,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  const { signal, cleanup } = createRequestSignal(
    FETCH_TIMEOUT_MS,
    externalSignal,
  );

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
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch (error) {
    if (externalSignal?.aborted || isCancellationError(error)) {
      throw new Error("Extraction cancelled by user");
    }
    return null;
  } finally {
    cleanup();
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
    images: collectImagesFromBlocks(fallback.contentBlocks),
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
    "are you a robot",
    "unusual activity",
    "access denied",
    "forbidden",
    "captcha",
    "cloudflare",
  ];

  return markers.some((marker) => combined.includes(marker));
}

function buildBlockedError(url: string): Error {
  const host = new URL(url).hostname;

  return new Error(
    [
      `Gagal mengambil ${url} (blocked/no readable content).`,
      "Kemungkinan situs dilindungi anti-bot/CAPTCHA atau butuh autentikasi.",
      "Coba langkah berikut:",
      "1) Import/set cookie valid dari browser login.",
      "   - EXTRACT_COOKIE='cf_clearance=...; ...'",
      `   - EXTRACT_COOKIE_MAP='{"${host}":"cf_clearance=...; ..."}'`,
      "2) Aktifkan browser fallback (cookie akan dipasang ke sesi browser):",
      "EXTRACT_BROWSER_FALLBACK=1 (opsional: EXTRACT_BROWSER_HEADLESS=0 untuk verifikasi manual, EXTRACT_BROWSER_WAIT_MS=120000).",
    ].join(" "),
  );
}

function shouldAutoBrowserFallback(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return AUTO_BROWSER_FALLBACK_HOSTS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function looksLikeUnreadableExtraction(page: ExtractedPage): boolean {
  const normalizedTitle = page.title.trim().toLowerCase();
  const normalizedArticleTitle = page.articleTitle.trim().toLowerCase();
  const normalizedBody = page.articleBodyText.trim().toLowerCase();

  if (normalizedBody.length < 120) {
    if (!normalizedBody) {
      return true;
    }

    if (
      normalizedTitle.length > 0 &&
      normalizedBody === normalizedTitle &&
      normalizedArticleTitle === normalizedTitle
    ) {
      return true;
    }
  }

  return false;
}

async function fetchMediumProviderHtml(
  url: string,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  const hostname = new URL(url).hostname.toLowerCase();
  const isMediumHost =
    hostname === "medium.com" || hostname.endsWith(".medium.com");

  if (!isMediumHost) {
    return null;
  }

  const { signal, cleanup } = createRequestSignal(
    FETCH_TIMEOUT_MS,
    externalSignal,
  );

  try {
    const response = await fetch(`https://freedium.cfd/${url}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch (error) {
    if (externalSignal?.aborted || isCancellationError(error)) {
      throw new Error("Extraction cancelled by user");
    }
    return null;
  } finally {
    cleanup();
  }
}

export async function fetchArchiveProviderHtml(
  url: string,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  const { signal, cleanup } = createRequestSignal(
    FETCH_TIMEOUT_MS * 2,
    externalSignal,
  );

  try {
    const archiveUrl = `https://archive.is/newest/${url}`;
    const res1 = await fetch(archiveUrl, {
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal,
    });

    if (res1.status !== 302 && !res1.ok) {
      return null;
    }

    let finalUrl = archiveUrl;
    if (res1.status === 302) {
      const loc = res1.headers.get("location");
      if (!loc) return null;
      finalUrl = loc;
    }

    const res2 = await fetch(finalUrl, {
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal,
    });

    if (!res2.ok) {
      return null;
    }

    const html = await res2.text();
    if (
      html.includes("Please complete the security check to access") ||
      html.includes("g-recaptcha") ||
      html.includes("No results")
    ) {
      return null;
    }

    return html;
  } catch (error) {
    if (externalSignal?.aborted || isCancellationError(error)) {
      throw new Error("Extraction cancelled by user");
    }
    return null;
  } finally {
    cleanup();
  }
}

export async function crawlCheerioDocs(
  rootUrl: string,
  maxPages: number,
  options?: CrawlOptions,
): Promise<ExtractionResult> {
  const archiveOriginalRootUrl = extractArchiveOriginalUrl(rootUrl);
  const disableQueueForArchiveSnapshot = Boolean(archiveOriginalRootUrl);
  const scopedRootUrl = new URL(rootUrl);
  const queueLimit = Math.max(
    maxPages * QUEUE_LIMIT_MULTIPLIER,
    MIN_QUEUE_LIMIT,
  );

  const cheerio = await loadCheerioModule();

  const queue: string[] = [scopedRootUrl.toString()];
  const queued = new Set<string>([scopedRootUrl.toString()]);
  const visited = new Set<string>();
  const pages: ExtractedPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    throwIfCancelled(options);

    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    queued.delete(currentUrl);
    visited.add(currentUrl);
    await options?.onProgress?.({
      step: "page-start",
      url: currentUrl,
      crawledPages: pages.length,
      queueLength: queue.length,
      maxPages,
      message: `Memproses halaman ${pages.length + 1}/${maxPages}: ${currentUrl}`,
    });

    try {
      throwIfCancelled(options);
      let extracted: ExtractedPage | null = null;
      const forceBrowser = isBrowserFallbackForced();
      const autoBrowserFallback = shouldAutoBrowserFallback(currentUrl);

      if (forceBrowser) {
        await options?.onProgress?.({
          step: "page-start",
          url: currentUrl,
          crawledPages: pages.length,
          queueLength: queue.length,
          maxPages,
          message: `Browser fallback dipaksa untuk: ${currentUrl}`,
        });
        const browserHtml = await fetchBrowserFallbackHtml(currentUrl, {
          force: true,
          signal: options?.signal,
        });

        if (browserHtml) {
          const browserExtracted = extractPageFromHtml(
            currentUrl,
            browserHtml,
            scopedRootUrl,
            cheerio.load,
          );

          if (browserExtracted.articleBodyText.length > 80) {
            extracted = browserExtracted;
          }
        }
      }

      const html = extracted
        ? null
        : await fetchHtml(currentUrl, options?.signal);
      if (!extracted && html) {
        extracted = extractPageFromHtml(
          currentUrl,
          html,
          scopedRootUrl,
          cheerio.load,
        );
      }

      if (
        html &&
        (!extracted ||
          looksLikeBlockedPage(extracted) ||
          looksLikeUnreadableExtraction(extracted) ||
          extracted.articleBodyText.length < 160)
      ) {
        await options?.onProgress?.({
          step: "page-start",
          url: currentUrl,
          crawledPages: pages.length,
          queueLength: queue.length,
          maxPages,
          message: `Fallback JSDOM/Readability untuk: ${currentUrl}`,
        });
        const jsdomExtracted = extractPageWithJsdomFallback(
          currentUrl,
          html,
          scopedRootUrl,
        );

        if (jsdomExtracted && !looksLikeBlockedPage(jsdomExtracted)) {
          if (
            !extracted ||
            looksLikeBlockedPage(extracted) ||
            looksLikeUnreadableExtraction(extracted) ||
            jsdomExtracted.articleBodyText.length >
              extracted.articleBodyText.length
          ) {
            extracted = jsdomExtracted;
          }
        }
      }

      const blockedByChallenge = extracted
        ? looksLikeBlockedPage(extracted)
        : false;

      if (
        !extracted ||
        extracted.articleBodyText.length < 160 ||
        blockedByChallenge
      ) {
        await options?.onProgress?.({
          step: "page-start",
          url: currentUrl,
          crawledPages: pages.length,
          queueLength: queue.length,
          maxPages,
          message: `Fallback konten ter-render untuk: ${currentUrl}`,
        });
        const fallback = await fetchRenderedFallbackArticle(currentUrl, {
          signal: options?.signal,
        });

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
          extracted.images = collectImagesFromBlocks(fallback.contentBlocks);
          extracted.imageCount = fallback.imageCount;
          extracted.publishedAt = fallback.publishedAt ?? extracted.publishedAt;
          extracted.isArticlePage = fallback.articleBodyText.length > 80;
        }
      }

      const stillBlocked = extracted ? looksLikeBlockedPage(extracted) : false;

      if (!extracted || stillBlocked) {
        const mediumProviderHtml = await fetchMediumProviderHtml(
          currentUrl,
          options?.signal,
        );

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

      const stillBlocked2 = extracted ? looksLikeBlockedPage(extracted) : false;

      if (!extracted || stillBlocked2) {
        await options?.onProgress?.({
          step: "page-start",
          url: currentUrl,
          crawledPages: pages.length,
          queueLength: queue.length,
          maxPages,
          message: `Mencari snapshot Archive.is untuk: ${currentUrl}`,
        });
        const archiveHtml = await fetchArchiveProviderHtml(
          currentUrl,
          options?.signal,
        );

        if (archiveHtml) {
          let archiveExtracted = extractPageFromHtml(
            currentUrl,
            archiveHtml,
            scopedRootUrl,
            cheerio.load,
          );

          if (!looksLikeBlockedPage(archiveExtracted)) {
            const jsdomArchive = extractPageWithJsdomFallback(
              currentUrl,
              archiveHtml,
              scopedRootUrl,
            );
            if (
              jsdomArchive &&
              jsdomArchive.articleBodyText.length >
                archiveExtracted.articleBodyText.length
            ) {
              archiveExtracted = jsdomArchive;
            }
          }

          if (
            !looksLikeBlockedPage(archiveExtracted) &&
            archiveExtracted.articleBodyText.length > 160
          ) {
            extracted = archiveExtracted;
          }
        }
      }

      if (
        !extracted ||
        looksLikeBlockedPage(extracted) ||
        looksLikeUnreadableExtraction(extracted)
      ) {
        const browserForce = forceBrowser || autoBrowserFallback;
        await options?.onProgress?.({
          step: "page-start",
          url: currentUrl,
          crawledPages: pages.length,
          queueLength: queue.length,
          maxPages,
          message: browserForce
            ? `Fallback browser otomatis untuk: ${currentUrl}`
            : `Fallback browser opsional untuk: ${currentUrl}`,
        });
        const browserHtml = await fetchBrowserFallbackHtml(currentUrl, {
          force: browserForce,
          signal: options?.signal,
        });

        if (browserHtml) {
          const browserExtracted = extractPageFromHtml(
            currentUrl,
            browserHtml,
            scopedRootUrl,
            cheerio.load,
          );

          if (
            !looksLikeBlockedPage(browserExtracted) &&
            browserExtracted.articleBodyText.length > 160
          ) {
            extracted = browserExtracted;
          }
        }
      }

      if (
        !extracted ||
        looksLikeBlockedPage(extracted) ||
        looksLikeUnreadableExtraction(extracted)
      ) {
        throw buildBlockedError(currentUrl);
      }

      if (disableQueueForArchiveSnapshot) {
        const originalCurrentUrl = extractArchiveOriginalUrl(currentUrl);
        if (originalCurrentUrl) {
          extracted.url = originalCurrentUrl;
        }
      }

      pages.push(extracted);
      await options?.onProgress?.({
        step: "page-done",
        url: currentUrl,
        crawledPages: pages.length,
        queueLength: queue.length,
        maxPages,
        message: `Berhasil: ${pages.length}/${maxPages} halaman`,
      });

      if (disableQueueForArchiveSnapshot) {
        continue;
      }

      let scannedLinks = 0;
      for (const link of extracted.links) {
        if (isCancelled(options)) {
          break;
        }
        if (
          scannedLinks >= MAX_LINKS_SCANNED_PER_PAGE ||
          queue.length >= queueLimit
        ) {
          break;
        }
        scannedLinks += 1;

        if (
          !visited.has(link) &&
          !queued.has(link) &&
          shouldQueueLink(link, scopedRootUrl)
        ) {
          queue.push(link);
          queued.add(link);
        }
      }
    } catch (error) {
      if (isCancelled(options) || isCancellationError(error)) {
        throw new Error("Extraction cancelled by user");
      }
      await options?.onProgress?.({
        step: "page-failed",
        url: currentUrl,
        crawledPages: pages.length,
        queueLength: queue.length,
        maxPages,
        message: `Gagal halaman: ${currentUrl}`,
      });
      if (pages.length === 0) {
        throw buildBlockedError(currentUrl);
      }
      continue;
    }
  }

  return {
    rootUrl: archiveOriginalRootUrl ?? scopedRootUrl.toString(),
    maxPages,
    crawledPages: pages.length,
    collectedAt: new Date().toISOString(),
    pages,
  };
}
