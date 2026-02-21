import { mkdir, readdir, unlink } from "node:fs/promises";
import { crawlCheerioDocs } from "../extractor/crawler";
import {
  buildArticleMarkdown,
  buildArticleText,
  slugifyTitle,
} from "../extractor/markdown";
import type { ExtractionResult } from "../extractor/types";
import {
  buildSiteFolderName,
  buildRunId,
  readManifest,
  writeSiteManifest,
  writeManifest,
  type RunManifestItem,
} from "./run-store";

export type ExtractRequest = {
  rootUrl: string;
  maxPages: number;
  outputRoot: string;
};

export type ExtractionProgress = {
  step: string;
  message: string;
};

export type ExtractOptions = {
  onProgress?: (progress: ExtractionProgress) => Promise<void> | void;
};

export type ExtractResponse = {
  runId: string;
  site: string;
  resultFile: string;
  markdownFiles: string[];
  textFiles: string[];
  result: ExtractionResult;
};

function pickExportablePages(
  result: ExtractionResult,
): ExtractionResult["pages"] {
  const articlePages = result.pages.filter((page) => page.isArticlePage);

  if (articlePages.length > 0) {
    return articlePages;
  }

  // Fallback: tetap kirim hasil untuk halaman pertama agar user selalu dapat file md/txt.
  const firstPage = result.pages[0];
  return firstPage ? [firstPage] : [];
}

function toTimestampSlug(isoTimestamp: string): string {
  return isoTimestamp
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("T", "_");
}

function sortByCreatedAtDesc(items: RunManifestItem[]): RunManifestItem[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildPageSignature(page: ExtractionResult["pages"][number]): string {
  return JSON.stringify({
    formatVersion: 4,
    url: page.url,
    articleTitle: page.articleTitle,
    description: page.description,
    articleBodyText: page.articleBodyText,
    contentBlocks: page.contentBlocks,
    images: page.images,
    publishedAt: page.publishedAt,
  });
}

async function writeVersionedFile(
  latestPath: string,
  historyPath: string,
  content: string,
): Promise<void> {
  const latestFile = Bun.file(latestPath);
  const latestExists = await latestFile.exists();

  if (latestExists) {
    const previous = await latestFile.text();
    if (previous === content) {
      return;
    }
  }

  await Bun.write(latestPath, content);
  await Bun.write(historyPath, content);
}

async function cleanupDuplicateHistoryFiles(historyDir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(historyDir);
  } catch {
    return;
  }

  const byExtension = new Map<string, string[]>();
  for (const name of names) {
    const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
    if (!ext || !["md", "txt", "json"].includes(ext)) {
      continue;
    }

    const list = byExtension.get(ext) ?? [];
    list.push(name);
    byExtension.set(ext, list);
  }

  for (const [, files] of byExtension.entries()) {
    const ext = files[0]?.split(".").at(-1)?.toLowerCase() ?? "";
    files.sort((a, b) => b.localeCompare(a));
    const seen = new Set<string>();

    for (const fileName of files) {
      const fullPath = `${historyDir}/${fileName}`;
      const content = await Bun.file(fullPath).text();
      const normalized = normalizeHistoryContent(ext, content);
      if (seen.has(normalized)) {
        await unlink(fullPath).catch(() => {});
        continue;
      }
      seen.add(normalized);
    }
  }
}

function normalizeHistoryContent(ext: string, content: string): string {
  if (ext === "md") {
    return content
      .replaceAll(/^DATE: .*$/gm, "DATE: __normalized__")
      .replaceAll(/^collectedAt: .*$/gm, "collectedAt: __normalized__");
  }

  if (ext === "txt") {
    return content.replaceAll(/^DATE: .*$/gm, "DATE: __normalized__");
  }

  return content;
}

async function writePageOutputs(
  result: ExtractionResult,
  outputRoot: string,
  site: string,
): Promise<{
  markdownFiles: string[];
  textFiles: string[];
  articleDirs: string[];
}> {
  const pagesToExport = pickExportablePages(result);
  const timestampSlug = toTimestampSlug(result.collectedAt);
  const markdownFiles: string[] = [];
  const textFiles: string[] = [];
  const articleDirs: string[] = [];
  const usedArticleDirs = new Set<string>();

  for (const page of pagesToExport) {
    const articleSlugBase = slugifyTitle(page.articleTitle);
    let articleSlug = articleSlugBase;
    let articleDir = `${outputRoot}/sites/${site}/${articleSlug}`;
    let suffix = 2;

    while (usedArticleDirs.has(articleDir)) {
      articleSlug = `${articleSlugBase}-${suffix}`;
      articleDir = `${outputRoot}/sites/${site}/${articleSlug}`;
      suffix += 1;
    }

    usedArticleDirs.add(articleDir);
    const historyDir = `${articleDir}/history`;
    await mkdir(historyDir, { recursive: true });

    const markdown = buildArticleMarkdown(page, result.collectedAt);
    const textOutput = buildArticleText(
      {
        ...page,
        description: page.description,
      },
      result.collectedAt,
    );
    const pageJson = `${JSON.stringify(page, null, 2)}\n`;

    const latestMarkdown = `${articleDir}/latest.md`;
    const latestText = `${articleDir}/latest.txt`;
    const latestJson = `${articleDir}/latest.json`;
    const latestMeta = `${articleDir}/latest.meta.json`;

    const historyMarkdown = `${historyDir}/${timestampSlug}.md`;
    const historyText = `${historyDir}/${timestampSlug}.txt`;
    const historyJson = `${historyDir}/${timestampSlug}.json`;

    const signature = buildPageSignature(page);
    const metaFile = Bun.file(latestMeta);
    const metaExists = await metaFile.exists();
    let previousSignature = "";

    if (metaExists) {
      try {
        const parsed = JSON.parse(await metaFile.text()) as {
          signature?: string;
        };
        previousSignature = parsed.signature ?? "";
      } catch {
        previousSignature = "";
      }
    }

    const hasContentChanged = previousSignature !== signature;
    if (hasContentChanged) {
      await writeVersionedFile(latestMarkdown, historyMarkdown, markdown);
      await writeVersionedFile(latestText, historyText, textOutput);
      await writeVersionedFile(latestJson, historyJson, pageJson);
      await Bun.write(
        latestMeta,
        `${JSON.stringify(
          {
            signature,
            updatedAt: result.collectedAt,
          },
          null,
          2,
        )}\n`,
      );
    }
    await cleanupDuplicateHistoryFiles(historyDir);

    page.markdownPath = latestMarkdown;
    markdownFiles.push(latestMarkdown);
    textFiles.push(latestText);
    articleDirs.push(articleDir);
  }

  return { markdownFiles, textFiles, articleDirs };
}

export async function runExtraction(
  request: ExtractRequest,
  options?: ExtractOptions,
): Promise<ExtractResponse> {
  const report = async (step: string, message: string): Promise<void> => {
    try {
      await options?.onProgress?.({ step, message });
    } catch {
      // Progress update tidak boleh menghentikan proses extract.
    }
  };

  await report("init", "Menyiapkan proses extract");
  const runId = buildRunId();
  const site = buildSiteFolderName(request.rootUrl);
  const startedAt = Date.now();

  await report("crawl", "Mengambil dan memproses konten halaman");
  const result = await crawlCheerioDocs(request.rootUrl, request.maxPages, {
    onProgress: async (progress) => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      await report(
        "crawl",
        `${progress.message} | queue=${progress.queueLength} | elapsed=${elapsedSec}s`,
      );
    },
  });
  const siteRoot = `${request.outputRoot}/sites/${site}`;
  await mkdir(siteRoot, { recursive: true });

  await report("files", "Menyusun file Markdown dan Text");
  const output = await writePageOutputs(result, request.outputRoot, site);
  const resultFile = `${siteRoot}/last-extract.json`;
  const historyRoot = `${siteRoot}/history`;
  await mkdir(historyRoot, { recursive: true });
  const historyResultFile = `${historyRoot}/${toTimestampSlug(result.collectedAt)}__extract.json`;

  await report("save", "Menyimpan file hasil dan manifest");
  await Bun.write(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  await Bun.write(historyResultFile, `${JSON.stringify(result, null, 2)}\n`);
  await Bun.write(
    `${request.outputRoot}/sites/${site}/latest.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );

  const globalManifest = await readManifest(request.outputRoot);
  const record: RunManifestItem = {
    id: runId,
    site,
    createdAt: result.collectedAt,
    rootUrl: result.rootUrl,
    maxPages: result.maxPages,
    crawledPages: result.crawledPages,
    articleFiles: output.markdownFiles.length,
    runDir: output.articleDirs[0] ?? siteRoot,
    resultFile,
  };

  const siteManifest = globalManifest.filter((item) => item.site === site);
  const filteredGlobal = globalManifest.filter((item) => item.id !== record.id);
  const filteredSite = siteManifest.filter((item) => item.id !== record.id);
  filteredSite.push(record);
  filteredGlobal.push(record);

  await writeSiteManifest(
    request.outputRoot,
    site,
    sortByCreatedAtDesc(filteredSite),
  );
  await writeManifest(request.outputRoot, sortByCreatedAtDesc(filteredGlobal));
  await report("done", "Extract selesai");

  return {
    runId,
    site,
    resultFile,
    markdownFiles: output.markdownFiles,
    textFiles: output.textFiles,
    result,
  };
}
