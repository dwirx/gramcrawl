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
  ensureRunDirs,
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

async function writeArticleMarkdownFiles(
  result: ExtractionResult,
  markdownDir: string,
): Promise<string[]> {
  const usedNames = new Set<string>();
  const files: string[] = [];

  const pagesToExport = pickExportablePages(result);

  for (const page of pagesToExport) {
    const base = slugifyTitle(page.articleTitle);
    let fileName = `${base}.md`;
    let counter = 2;

    while (usedNames.has(fileName)) {
      fileName = `${base}-${counter}.md`;
      counter += 1;
    }

    usedNames.add(fileName);

    const path = `${markdownDir}/${fileName}`;
    const markdown = buildArticleMarkdown(page, result.collectedAt);

    await Bun.write(path, markdown);
    page.markdownPath = path;
    files.push(path);
  }

  return files;
}

async function writeArticleTextFiles(
  result: ExtractionResult,
  textDir: string,
): Promise<string[]> {
  const usedNames = new Set<string>();
  const files: string[] = [];

  const pagesToExport = pickExportablePages(result);

  for (const page of pagesToExport) {
    const base = slugifyTitle(page.articleTitle);
    let fileName = `${base}.txt`;
    let counter = 2;

    while (usedNames.has(fileName)) {
      fileName = `${base}-${counter}.txt`;
      counter += 1;
    }

    usedNames.add(fileName);

    const path = `${textDir}/${fileName}`;
    const textOutput = buildArticleText(page, result.collectedAt);

    await Bun.write(path, textOutput);
    files.push(path);
  }

  return files;
}

export async function runExtraction(
  request: ExtractRequest,
  options?: ExtractOptions,
): Promise<ExtractResponse> {
  const report = async (step: string, message: string): Promise<void> => {
    await options?.onProgress?.({ step, message });
  };

  await report("init", "Menyiapkan proses extract");
  const runId = buildRunId();
  const site = buildSiteFolderName(request.rootUrl);
  const { runDir, markdownDir, textDir } = await ensureRunDirs(
    request.outputRoot,
    site,
    runId,
  );

  await report("crawl", "Mengambil dan memproses konten halaman");
  const result = await crawlCheerioDocs(request.rootUrl, request.maxPages);
  await report("files", "Menyusun file Markdown dan Text");
  const markdownFiles = await writeArticleMarkdownFiles(result, markdownDir);
  const textFiles = await writeArticleTextFiles(result, textDir);
  const resultFile = `${runDir}/extract.json`;

  await report("save", "Menyimpan file hasil dan manifest");
  await Bun.write(resultFile, `${JSON.stringify(result, null, 2)}\n`);
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
    articleFiles: markdownFiles.length,
    runDir,
    resultFile,
  };

  const siteManifest = globalManifest.filter((item) => item.site === site);
  siteManifest.unshift(record);
  globalManifest.unshift(record);

  await writeSiteManifest(request.outputRoot, site, siteManifest);
  await writeManifest(request.outputRoot, globalManifest);
  await report("done", "Extract selesai");

  return {
    runId,
    site,
    resultFile,
    markdownFiles,
    textFiles,
    result,
  };
}
