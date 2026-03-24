import { rm, readdir } from "node:fs/promises";
import { normalizeExtractionUrl } from "../../extractor/url-utils";
import { buildSiteFolderName } from "../../app/run-store";
import {
  EXTRACT_DEFAULT_TIMEOUT_BASE_MS,
  EXTRACT_DEFAULT_TIMEOUT_PER_PAGE_MS,
  EXTRACT_DEFAULT_TIMEOUT_MAX_MS,
} from "../constants";
import { readPositiveIntEnv } from "../runtime-utils";

export function buildExtractCacheKey(url: string, maxPages: number): string {
  try {
    const normalized = normalizeExtractionUrl(url);
    return `${normalized}::${maxPages}`;
  } catch {
    return `${url.trim()}::${maxPages}`;
  }
}

export function resolveExtractJobTimeoutMs(maxPages: number): number {
  const configured = readPositiveIntEnv("EXTRACT_BOT_JOB_TIMEOUT_MS", 0);
  if (configured > 0) {
    return configured;
  }

  const estimated =
    EXTRACT_DEFAULT_TIMEOUT_BASE_MS +
    Math.max(1, maxPages) * EXTRACT_DEFAULT_TIMEOUT_PER_PAGE_MS;
  return Math.min(estimated, EXTRACT_DEFAULT_TIMEOUT_MAX_MS);
}

export function parseSiteScope(siteInput: string | undefined): string {
  const raw = siteInput?.trim().toLowerCase() ?? "";
  if (!raw) {
    return "";
  }

  if (raw.includes("://")) {
    return buildSiteFolderName(raw);
  }

  if (/^[a-z0-9.-]+$/u.test(raw)) {
    return raw;
  }

  return buildSiteFolderName(`https://${raw}`);
}

export async function removeDirectoriesByName(
  rootDir: string,
  targetName: string,
): Promise<number> {
  let removed = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === targetName) {
          try {
            await rm(entryPath, { recursive: true, force: true });
            removed += 1;
          } catch {
            // ignore
          }
        } else {
          stack.push(entryPath);
        }
      }
    }
  }

  return removed;
}
