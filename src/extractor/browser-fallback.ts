import type { BrowserContext } from "playwright";

function shouldEnableBrowserFallback(): boolean {
  return process.env.EXTRACT_BROWSER_FALLBACK === "1";
}

export function isBrowserFallbackForced(): boolean {
  return process.env.EXTRACT_BROWSER_FORCE === "1";
}

function isHeadless(): boolean {
  return process.env.EXTRACT_BROWSER_HEADLESS !== "0";
}

function getBrowserEngine(): "chromium" | "lightpanda" {
  const engine = (process.env.EXTRACT_BROWSER_ENGINE ?? "chromium")
    .trim()
    .toLowerCase();
  return engine === "lightpanda" ? "lightpanda" : "chromium";
}

function getWaitTimeoutMs(): number {
  const raw = Number(process.env.EXTRACT_BROWSER_WAIT_MS ?? "90000");

  if (!Number.isFinite(raw) || raw < 5_000) {
    return 90_000;
  }

  return Math.floor(raw);
}

const BROWSER_LAUNCH_TIMEOUT_MS = 45_000;
const BROWSER_STEP_TIMEOUT_MS = 12_000;
const BROWSER_CLOSE_TIMEOUT_MS = 8_000;

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

async function runWithTimeoutAndSignal<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Extraction cancelled by user");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const finalize = (onDone: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      onDone();
    };

    const onAbort = (): void => {
      finalize(() => reject(new Error("Extraction cancelled by user")));
    };

    const timer = setTimeout(() => {
      finalize(() => reject(new Error(`Operation timeout (${timeoutMs}ms)`)));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    void run().then(
      (value) => finalize(() => resolve(value)),
      (error) => finalize(() => reject(error)),
    );
  });
}

async function closeContextSafely(context: BrowserContext | null) {
  if (!context) {
    return;
  }

  await runWithTimeoutAndSignal(
    () => context.close(),
    BROWSER_CLOSE_TIMEOUT_MS,
  ).catch(() => {});
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
    "checking your browser",
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

async function fetchLightpandaHtml(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let lightpandaModule: typeof import("@lightpanda/browser");
  let playwrightModule: typeof import("playwright");
  try {
    lightpandaModule = await import("@lightpanda/browser");
    playwrightModule = await import("playwright");
  } catch {
    return null;
  }

  const port = 9222 + Math.floor(Math.random() * 100);
  let proc: import("node:child_process").ChildProcessWithoutNullStreams | null =
    null;

  try {
    proc = await lightpandaModule.lightpanda.serve({ port });

    // Wait for CDP server to be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const browser = await runWithTimeoutAndSignal(
      () =>
        playwrightModule.chromium.connectOverCDP(`http://127.0.0.1:${port}`),
      BROWSER_LAUNCH_TIMEOUT_MS,
      signal,
    );

    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    await runWithTimeoutAndSignal(
      () =>
        page.goto(url, {
          waitUntil: "networkidle",
          timeout: 45_000,
        }),
      55_000,
      signal,
    );

    const html = await runWithTimeoutAndSignal(
      () => page.content(),
      BROWSER_STEP_TIMEOUT_MS,
      signal,
    );

    await browser.close();
    return html;
  } catch (error) {
    console.error("Lightpanda error:", error);
    return null;
  } finally {
    if (proc) {
      proc.kill();
    }
  }
}

export async function fetchBrowserFallbackHtml(
  url: string,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  const force = options?.force ?? false;
  const signal = options?.signal;
  if (!shouldEnableBrowserFallback() && !force) {
    return null;
  }

  const engine = getBrowserEngine();

  if (engine === "lightpanda") {
    const html = await fetchLightpandaHtml(url, signal);
    if (html && !looksLikeChallengePage(html)) {
      return html;
    }
    // Fallback to chromium if lightpanda failed or hit challenge
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
  let context: BrowserContext | null = null;
  let onAbortClose: (() => void) | null = null;

  try {
    context = await runWithTimeoutAndSignal(
      () =>
        playwrightModule.chromium.launchPersistentContext(userDataDir, {
          headless,
          viewport: { width: 1366, height: 900 },
        }),
      BROWSER_LAUNCH_TIMEOUT_MS,
      signal,
    );

    if (signal) {
      onAbortClose = () => {
        void closeContextSafely(context);
      };
      signal.addEventListener("abort", onAbortClose, { once: true });
    }

    if (!context) {
      return null;
    }
    const activeContext = context;

    const cookieHeader = readCookieOverride(url);
    if (cookieHeader) {
      const cookies = parseCookieHeaderToBrowserCookies(
        cookieHeader,
        parsed.hostname,
      );
      if (cookies.length > 0) {
        await runWithTimeoutAndSignal(
          () => activeContext.addCookies(cookies),
          BROWSER_STEP_TIMEOUT_MS,
          signal,
        );
      }
    }

    const page =
      activeContext.pages()[0] ??
      (await runWithTimeoutAndSignal(
        () => activeContext.newPage(),
        BROWSER_STEP_TIMEOUT_MS,
        signal,
      ));
    await runWithTimeoutAndSignal(
      () =>
        page.goto(url, {
          waitUntil: "networkidle",
          timeout: 45_000,
        }),
      55_000,
      signal,
    );

    const startedAt = Date.now();
    let html = await runWithTimeoutAndSignal(
      () => page.content(),
      BROWSER_STEP_TIMEOUT_MS,
      signal,
    );

    while (
      looksLikeChallengePage(html) &&
      Date.now() - startedAt < waitTimeoutMs
    ) {
      await runWithTimeoutAndSignal(
        () => page.waitForTimeout(1_500),
        BROWSER_STEP_TIMEOUT_MS,
        signal,
      );
      html = await runWithTimeoutAndSignal(
        () => page.content(),
        BROWSER_STEP_TIMEOUT_MS,
        signal,
      );
    }

    if (looksLikeChallengePage(html)) {
      return null;
    }

    return html;
  } catch (error) {
    if (signal?.aborted || isCancellationError(error)) {
      throw new Error("Extraction cancelled by user");
    }
    return null;
  } finally {
    if (signal && onAbortClose) {
      signal.removeEventListener("abort", onAbortClose);
    }
    await closeContextSafely(context);
  }
}
