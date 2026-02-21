type CookieMap = Record<string, string>;

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#httponly_/i, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\./, "");
}

function parseCookieMap(rawValue: string | undefined): CookieMap {
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [
          normalizeDomain(key),
          (value as string).trim(),
        ]),
    );
  } catch {
    return {};
  }
}

function readEnvLines(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  return content.replaceAll(/\r\n/g, "\n").split("\n");
}

function findEnvValue(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const currentKey = trimmed.slice(0, index).trim();
    if (currentKey !== key) {
      continue;
    }

    return trimmed.slice(index + 1).trim();
  }

  return undefined;
}

function upsertEnvValue(lines: string[], key: string, value: string): string[] {
  const rendered = `${key}=${value}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      return line;
    }

    const currentKey = trimmed.slice(0, index).trim();
    if (currentKey !== key) {
      return line;
    }

    replaced = true;
    return rendered;
  });

  if (!replaced) {
    nextLines.push(rendered);
  }

  return nextLines;
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}

function parseNetscapeCookieLine(line: string): {
  domain: string;
  expiresAt: number;
  name: string;
  value: string;
} | null {
  const parts = line.split("\t");
  if (parts.length < 7) {
    return null;
  }

  const domain = normalizeDomain(parts[0] ?? "");
  const expiresAtRaw = Number(parts[4] ?? "0");
  const name = (parts[5] ?? "").trim();
  const value = (parts[6] ?? "").trim();

  if (!domain || !name) {
    return null;
  }

  return {
    domain,
    expiresAt: Number.isFinite(expiresAtRaw) ? expiresAtRaw : 0,
    name,
    value,
  };
}

export function extractCookieMapFromNetscape(fileText: string): CookieMap {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const perDomain = new Map<string, Map<string, string>>();
  const lines = fileText.replaceAll(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_");

    if (!trimmed || isComment) {
      continue;
    }

    const parsed = parseNetscapeCookieLine(trimmed);
    if (!parsed) {
      continue;
    }

    const isExpired = parsed.expiresAt > 0 && parsed.expiresAt < nowEpoch;
    if (isExpired) {
      continue;
    }

    const current = perDomain.get(parsed.domain) ?? new Map<string, string>();
    current.set(parsed.name, parsed.value);
    perDomain.set(parsed.domain, current);
  }

  return Object.fromEntries(
    Array.from(perDomain.entries()).map(([domain, cookies]) => {
      const header = Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      return [domain, header];
    }),
  );
}

export function extractCookieHeaderFromNetscape(
  fileText: string,
  rawDomain: string,
): string {
  const domain = normalizeDomain(rawDomain);
  const cookieMap = extractCookieMapFromNetscape(fileText);
  const exact = cookieMap[domain] ?? "";

  if (exact) {
    return exact;
  }

  const fallback = Object.entries(cookieMap).find(([cookieDomain]) =>
    domain.endsWith(`.${cookieDomain}`),
  )?.[1];

  return fallback ?? "";
}

export async function writeCookieToEnv(
  envPath: string,
  rawDomain: string,
  cookieHeader: string,
): Promise<{ domain: string; envPath: string; cookieMapJson: string }> {
  const domain = normalizeDomain(rawDomain);
  const envFile = Bun.file(envPath);
  const content = (await envFile.exists()) ? await envFile.text() : "";
  const lines = readEnvLines(content);
  const existingRaw = findEnvValue(lines, "EXTRACT_COOKIE_MAP");
  const existingMap = parseCookieMap(existingRaw);

  existingMap[domain] = cookieHeader.trim();

  const updatedMap = Object.fromEntries(
    Object.entries(existingMap).sort((a, b) => a[0].localeCompare(b[0])),
  );
  const cookieMapJson = JSON.stringify(updatedMap);
  const nextLines = upsertEnvValue(
    lines,
    "EXTRACT_COOKIE_MAP",
    quoteEnvValue(cookieMapJson),
  );
  const nextContent = `${nextLines.join("\n").trimEnd()}\n`;

  await Bun.write(envPath, nextContent);
  process.env.EXTRACT_COOKIE_MAP = cookieMapJson;

  return { domain, envPath, cookieMapJson };
}

export function hasCookieName(
  cookieHeader: string,
  cookieName: string,
): boolean {
  const target = cookieName.trim();
  if (!target) {
    return false;
  }

  return cookieHeader.split(";").some((part) => {
    const [name] = part.trim().split("=");
    return name?.trim() === target;
  });
}
