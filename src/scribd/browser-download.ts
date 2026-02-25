import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

const DOWNLOAD_BUTTON_PATTERNS = [/download/i, /unduh/i];

const DOWNLOAD_SELECTORS = [
  "[aria-label*='Download' i]",
  "[aria-label*='Unduh' i]",
  "[title*='Download' i]",
  "[title*='Unduh' i]",
  "button:has-text('Download')",
  "button:has-text('Unduh')",
  "a:has-text('Download')",
  "a:has-text('Unduh')",
  "[data-e2e*='download']",
  "[data-testid*='download']",
];

const SCRIBD_FORMATS = ["pdf", "docx", "txt"] as const;
type ScribdDownloadFormat = (typeof SCRIBD_FORMATS)[number];
type FormatConfig = {
  patterns: RegExp[];
  selectors: string[];
};

const FORMAT_CONFIG: Record<ScribdDownloadFormat, FormatConfig> = {
  pdf: {
    patterns: [/pdf/i, /portable document/i],
    selectors: [
      "[data-format='pdf']",
      "[data-e2e*='pdf']",
      "[data-testid*='pdf']",
      "button:has-text('PDF')",
      "a:has-text('PDF')",
    ],
  },
  docx: {
    patterns: [/docx/i, /word/i],
    selectors: [
      "[data-format='docx']",
      "[data-e2e*='docx']",
      "[data-testid*='docx']",
      "button:has-text('Docx')",
      "a:has-text('Docx')",
      "button:has-text('Word')",
      "a:has-text('Word')",
    ],
  },
  txt: {
    patterns: [/txt/i, /text/i, /plain text/i],
    selectors: [
      "[data-format='txt']",
      "[data-e2e*='txt']",
      "[data-testid*='txt']",
      "button:has-text('TXT')",
      "a:has-text('TXT')",
      "button:has-text('Text')",
      "a:has-text('Text')",
    ],
  },
};

type ScribdBrowserDownloadOptions = {
  url: string;
  outputRoot: string;
  waitMs: number;
  format: ScribdDownloadFormat;
};

type ScribdBrowserDownloadResult = {
  savedPath: string;
  fileName: string;
  outputDir: string;
};

function isScribdUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "scribd.com" || hostname.endsWith(".scribd.com");
}

function toSafeFilename(input: string): string {
  const collapsed = input.replaceAll(/[^\w.-]+/g, "_").replaceAll(/_+/g, "_");
  const trimmed = collapsed.replaceAll(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : `scribd_${Date.now()}.bin`;
}

async function clickByRoleName(
  page: Page,
  role: "button" | "link",
  patterns: RegExp[],
): Promise<boolean> {
  for (const pattern of patterns) {
    const locator = page.getByRole(role, { name: pattern });
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      await item.scrollIntoViewIfNeeded().catch(() => null);
      await item.click({ timeout: 1_200 }).catch(() => null);
      return true;
    }
  }

  return false;
}

async function clickBySelector(
  page: Page,
  selectors: string[],
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      await item.scrollIntoViewIfNeeded().catch(() => null);
      await item.click({ timeout: 1_200 }).catch(() => null);
      return true;
    }
  }

  return false;
}

async function clickByTextFallback(
  page: Page,
  textPattern: RegExp,
): Promise<boolean> {
  const clicked = await page
    .evaluate(
      (serializedPattern) => {
        const regex = new RegExp(
          serializedPattern.source,
          serializedPattern.flags,
        );
        const doc = (
          globalThis as unknown as {
            document?: {
              querySelectorAll: (selector: string) => unknown[];
            };
          }
        ).document;

        if (!doc) {
          return false;
        }

        const candidates = Array.from(
          doc.querySelectorAll(
            "button, a, [role='button'], [role='menuitem'], [data-e2e], [data-testid]",
          ),
        ) as Array<{
          innerText?: string;
          textContent?: string | null;
          getAttribute: (name: string) => string | null;
          click: () => void;
        }>;

        for (const candidate of candidates) {
          const text = [
            candidate.innerText,
            candidate.textContent,
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" ");
          if (!regex.test(text)) {
            continue;
          }
          candidate.click();
          return true;
        }

        return false;
      },
      { source: textPattern.source, flags: textPattern.flags },
    )
    .catch(() => false);

  return clicked;
}

async function openDownloadMenu(page: Page): Promise<boolean> {
  const clickedDownloadRole =
    (await clickByRoleName(page, "button", DOWNLOAD_BUTTON_PATTERNS)) ||
    (await clickByRoleName(page, "link", DOWNLOAD_BUTTON_PATTERNS));
  const clickedDownloadSelector = await clickBySelector(
    page,
    DOWNLOAD_SELECTORS,
  );
  const clickedDownloadText =
    (await clickByTextFallback(page, /download/i)) ||
    (await clickByTextFallback(page, /unduh/i));

  return clickedDownloadRole || clickedDownloadSelector || clickedDownloadText;
}

async function selectFormat(
  page: Page,
  format: ScribdDownloadFormat,
): Promise<boolean> {
  const formatConfig = FORMAT_CONFIG[format];
  const clickedFormatRole =
    (await clickByRoleName(page, "button", formatConfig.patterns)) ||
    (await clickByRoleName(page, "link", formatConfig.patterns));
  const clickedFormatSelector = await clickBySelector(
    page,
    formatConfig.selectors,
  );
  let clickedFormatText = false;
  for (const pattern of formatConfig.patterns) {
    clickedFormatText = await clickByTextFallback(page, pattern);
    if (clickedFormatText) {
      break;
    }
  }

  return clickedFormatRole || clickedFormatSelector || clickedFormatText;
}

async function tryDownloadInteractions(
  page: Page,
  format: ScribdDownloadFormat,
): Promise<boolean> {
  const clickedMenu = await openDownloadMenu(page);
  if (clickedMenu) {
    await page.waitForTimeout(350);
  }
  const clickedFormat = await selectFormat(page, format);

  return clickedMenu || clickedFormat;
}

export async function runScribdBrowserDownload(
  options: ScribdBrowserDownloadOptions,
): Promise<ScribdBrowserDownloadResult> {
  if (!isScribdUrl(options.url)) {
    throw new Error(
      "Command scribd-browser hanya untuk URL Scribd. Gunakan command extract untuk domain lain.",
    );
  }

  const { chromium } = await import("playwright");
  const outputDir = join(options.outputRoot, "scribd-downloads");
  await mkdir(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(
    ".cache/browser-profile/scribd",
    {
      headless: false,
      acceptDownloads: true,
      viewport: { width: 1366, height: 900 },
    },
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    let timedOut = false;
    const downloadPromise = page
      .waitForEvent("download", { timeout: options.waitMs })
      .catch(() => {
        timedOut = true;
        return null;
      });

    const startedAt = Date.now();
    while (Date.now() - startedAt < options.waitMs) {
      const downloaded = await Promise.race([
        downloadPromise,
        page.waitForTimeout(0).then(() => null),
      ]);

      if (downloaded) {
        const suggested = downloaded.suggestedFilename();
        const fileName = toSafeFilename(suggested);
        const savedPath = join(outputDir, fileName);
        await downloaded.saveAs(savedPath);
        return { savedPath, fileName, outputDir };
      }

      await tryDownloadInteractions(page, options.format);
      await page
        .waitForLoadState("networkidle", { timeout: 2_000 })
        .catch(() => null);
      await page.waitForTimeout(1_500);
    }

    if (timedOut) {
      throw new Error(
        "Timeout: download belum terdeteksi. Pastikan Anda sudah login dan dokumen memang punya izin download di akun Scribd Anda.",
      );
    }

    throw new Error("Download tidak terdeteksi.");
  } finally {
    await context.close();
  }
}
