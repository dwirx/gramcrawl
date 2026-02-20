export function isSupportedHref(rawHref: string): boolean {
  if (!rawHref || rawHref.startsWith("#")) {
    return false;
  }

  return !rawHref.startsWith("mailto:") && !rawHref.startsWith("javascript:");
}

export function isWithinOrigin(url: URL, rootUrl: URL): boolean {
  return url.origin === rootUrl.origin;
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
  resolved.hash = "";

  if (!isWithinOrigin(resolved, rootUrl)) {
    return null;
  }

  return resolved.toString();
}
