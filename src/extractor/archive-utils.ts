const ARCHIVE_HOSTS = new Set([
  "archive.is",
  "archive.today",
  "archive.ph",
  "archive.li",
  "archive.md",
  "archive.vn",
  "archive.fo",
]);

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function extractFirstUrlCandidate(input: string): string | null {
  const match = input.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) {
    return null;
  }

  const candidate = match[0].replaceAll(/[)\],.]+$/g, "");
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

export function isArchiveHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (ARCHIVE_HOSTS.has(host)) {
    return true;
  }

  for (const archiveHost of ARCHIVE_HOSTS) {
    if (host.endsWith(`.${archiveHost}`)) {
      return true;
    }
  }

  return false;
}

export function extractArchiveOriginalUrl(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (!isArchiveHost(parsed.hostname)) {
    return null;
  }

  const decodedPath = (() => {
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  })();
  const decodedSearch = (() => {
    try {
      return decodeURIComponent(parsed.search);
    } catch {
      return parsed.search;
    }
  })();

  return extractFirstUrlCandidate(`${decodedPath}${decodedSearch}`);
}

export function unwrapArchiveProxyUrl(input: string): string {
  return extractArchiveOriginalUrl(input) ?? input;
}
