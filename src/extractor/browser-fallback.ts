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

function parseCookieHeaderToBrowserCookies(
  cookieHeader: string,
  hostname: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  sameSite: "None";
}> {
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    sameSite: "None";
  }> = [];

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!name) {
      continue;
    }

    cookies.push({
      name,
      value,
      domain: hostname,
      path: "/",
      secure: true,
      sameSite: "None",
    });
  }

  return cookies;
}

export async function fetchBrowserFallbackHtml(
  url: string,
  options?: {
    force?: boolean;
  },
): Promise<string | null> {
  const force = options?.force ?? false;
  if (!shouldEnableBrowserFallback() && !force) {
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
    const cookieHeader = readCookieOverride(url);
    if (cookieHeader) {
      const cookies = parseCookieHeaderToBrowserCookies(
        cookieHeader,
        parsed.hostname,
      );
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

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
