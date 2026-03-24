export function isSupportedHref(rawHref: string): boolean {
  if (!rawHref || rawHref.startsWith("#")) {
    return false;
  }

  return !rawHref.startsWith("mailto:") && !rawHref.startsWith("javascript:");
}

export function isWithinOrigin(url: URL, rootUrl: URL): boolean {
  return url.origin === rootUrl.origin;
}

const GENERIC_TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

function isWsjHost(hostname: string): boolean {
  return hostname === "wsj.com" || hostname.endsWith(".wsj.com");
}

function shouldStripQueryParam(paramName: string, hostname: string): boolean {
  const lowered = paramName.toLowerCase();

  if (lowered.startsWith("utm_")) {
    return true;
  }

  if (GENERIC_TRACKING_QUERY_PARAMS.has(lowered)) {
    return true;
  }

  if (isWsjHost(hostname) && lowered === "mod") {
    return true;
  }

  return false;
}

function stripTrackingQueryParams(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (shouldStripQueryParam(key, hostname)) {
      url.searchParams.delete(key);
    }
  }
}

export function normalizeExtractionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    stripTrackingQueryParams(parsed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function normalizeScopedUrl(
  rawHref: string,
  currentPageUrl: URL,
  rootUrl: URL,
): string | null {
  if (!isSupportedHref(rawHref)) {
    return null;
  }

  const resolved = new URL(rawHref, currentPageUrl);
  stripTrackingQueryParams(resolved);
  resolved.hash = "";

  if (!isWithinOrigin(resolved, rootUrl)) {
    return null;
  }

  return resolved.toString();
}
