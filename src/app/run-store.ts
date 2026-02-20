import { mkdir } from "node:fs/promises";

export type RunManifestItem = {
  id: string;
  site: string;
  createdAt: string;
  rootUrl: string;
  maxPages: number;
  crawledPages: number;
  articleFiles: number;
  runDir: string;
  resultFile: string;
};

function sanitizeTimestamp(input: string): string {
  return input.replaceAll(":", "-").replaceAll(".", "-");
}

export function buildRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  return sanitizeTimestamp(iso);
}

export function buildSiteFolderName(rootUrl: string): string {
  try {
    const hostname = new URL(rootUrl).hostname.toLowerCase();
    return hostname.replaceAll(/[^a-z0-9.-]/g, "-") || "unknown-site";
  } catch {
    return "unknown-site";
  }
}

export async function ensureRunDirs(
  outputRoot: string,
  site: string,
  runId: string,
): Promise<{ runDir: string; markdownDir: string; textDir: string }> {
  const runDir = `${outputRoot}/sites/${site}/runs/${runId}`;
  const markdownDir = `${runDir}/markdown`;
  const textDir = `${runDir}/text`;

  await mkdir(markdownDir, { recursive: true });
  await mkdir(textDir, { recursive: true });

  return { runDir, markdownDir, textDir };
}

export async function readManifest(
  outputRoot: string,
): Promise<RunManifestItem[]> {
  const path = `${outputRoot}/runs-manifest.json`;
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return [];
  }

  const parsed = JSON.parse(await file.text()) as unknown;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return (parsed as RunManifestItem[]).map((item) => ({
    ...item,
    site: item.site || buildSiteFolderName(item.rootUrl),
  }));
}

export async function writeManifest(
  outputRoot: string,
  items: RunManifestItem[],
): Promise<void> {
  const path = `${outputRoot}/runs-manifest.json`;
  await Bun.write(path, `${JSON.stringify(items, null, 2)}\n`);
}

export async function writeSiteManifest(
  outputRoot: string,
  site: string,
  items: RunManifestItem[],
): Promise<void> {
  const siteRoot = `${outputRoot}/sites/${site}`;
  await mkdir(siteRoot, { recursive: true });
  const path = `${siteRoot}/runs-manifest.json`;
  await Bun.write(path, `${JSON.stringify(items, null, 2)}\n`);
}
