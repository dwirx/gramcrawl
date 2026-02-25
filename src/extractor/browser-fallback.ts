function shouldEnableBrowserFallback(): boolean {
  return process.env.EXTRACT_BROWSER_FALLBACK === "1";
}

export function isBrowserFallbackForced(): boolean {
  return process.env.EXTRACT_BROWSER_FORCE === "1";
}

function isHeadless(): boolean {
  return process.env.EXTRACT_BROWSER_HEADLESS !== "0";
}

function getWaitTimeoutMs(): number {
  const raw = Number(process.env.EXTRACT_BROWSER_WAIT_MS ?? "90000");

  if (!Number.isFinite(raw) || raw < 5_000) {
    return 90_000;
  }

  return Math.floor(raw);
}

function toUserDataDir(hostname: string): string {
  const safe = hostname.toLowerCase().replaceAll(/[^a-z0-9.-]/g, "-");
  return `.cache/browser-profile/${safe}`;
}

function looksLikeChallengePage(html: string): boolean {
  const lowered = html.toLowerCase();
  const markers = [
    "just a moment",
    "security verification",
    "verify you are not a bot",
    "enable javascript and cookies to continue",
    "turnstile",
    "captcha",
  ];

  return markers.some((marker) => lowered.includes(marker));
}

export async function fetchBrowserFallbackHtml(
  url: string,
): Promise<string | null> {
  if (!shouldEnableBrowserFallback()) {
    return null;
  }

  let playwrightModule: typeof import("playwright");
  try {
    playwrightModule = await import("playwright");
  } catch {
    return null;
  }

  const parsed = new URL(url);
  const headless = isHeadless();
  const waitTimeoutMs = getWaitTimeoutMs();
  const userDataDir = toUserDataDir(parsed.hostname);

  const context = await playwrightModule.chromium.launchPersistentContext(
    userDataDir,
    {
      headless,
      viewport: { width: 1366, height: 900 },
    },
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    const startedAt = Date.now();
    let html = await page.content();

    while (
      looksLikeChallengePage(html) &&
      Date.now() - startedAt < waitTimeoutMs
    ) {
      await page.waitForTimeout(1_500);
      html = await page.content();
    }

    if (looksLikeChallengePage(html)) {
      return null;
    }

    return html;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
