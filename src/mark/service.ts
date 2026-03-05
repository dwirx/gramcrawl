import { mkdir } from "node:fs/promises";

type MarkdownNewJson = {
  success?: boolean;
  url?: string;
  title?: string;
  content?: string;
  method?: string;
  tokens?: number;
  error?: string;
};

export type MarkExtractResult = {
  url: string;
  title: string;
  method: string;
  tokens: number | null;
  outputDir: string;
  markdownPath: string;
  textPath: string;
  metaPath: string;
};

const MARKDOWN_NEW_ENDPOINT = "https://markdown.new/";
const DEFUDDLE_ENDPOINT = "https://defuddle.md/";
const MARKDOWN_NEW_TIMEOUT_MS = 90_000;

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return normalized || "untitled";
}

function toTimestampSlug(now = new Date()): string {
  return now
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("T", "_");
}

function resolveMarkMethod(): "auto" | "ai" | "browser" {
  const raw = (process.env.EXTRACT_MARK_METHOD ?? "auto").trim().toLowerCase();
  if (raw === "ai" || raw === "browser") {
    return raw;
  }
  return "auto";
}

function resolveRetainImages(): boolean {
  return (process.env.EXTRACT_MARK_RETAIN_IMAGES ?? "1").trim() !== "0";
}

export function buildArticleOutputFileNames(title: string): {
  markdownFileName: string;
  textFileName: string;
  metaFileName: string;
} {
  const titleSlug = slugify(title);
  return {
    markdownFileName: `${titleSlug}.md`,
    textFileName: `${titleSlug}.txt`,
    metaFileName: `${titleSlug}.json`,
  };
}

export function buildDefuddleFetchUrl(url: string): string {
  const trimmed = url.trim();
  const stripped = trimmed.replace(/^https?:\/\//i, "");
  return `${DEFUDDLE_ENDPOINT}${stripped}`;
}

export function parseDefuddleTitleFromMarkdown(
  markdown: string,
): string | null {
  const frontmatterMatch = markdown.match(
    /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/,
  );
  if (!frontmatterMatch?.[1]) {
    return null;
  }

  const titleLine = frontmatterMatch[1].match(/^title:\s*(.+)$/im);
  if (!titleLine?.[1]) {
    return null;
  }

  const rawTitle = titleLine[1].trim();
  const unquoted = rawTitle.replace(/^['"]|['"]$/g, "");
  const normalized = normalizeWhitespace(unquoted);
  return normalized || null;
}

async function fetchMarkdownFromMarkdownNew(url: string): Promise<{
  title: string;
  content: string;
  method: string;
  tokens: number | null;
}> {
  const method = resolveMarkMethod();
  const retainImages = resolveRetainImages();
  const response = await fetch(MARKDOWN_NEW_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/markdown;q=0.9, text/plain;q=0.8",
    },
    body: JSON.stringify({
      url,
      method,
      retain_images: retainImages,
    }),
    signal: AbortSignal.timeout(MARKDOWN_NEW_TIMEOUT_MS),
  });

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  const headerTokens = Number(response.headers.get("x-markdown-tokens") ?? "");
  const tokens = Number.isFinite(headerTokens) ? headerTokens : null;

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as MarkdownNewJson;

    if (!response.ok || payload.success === false || !payload.content) {
      throw new Error(
        payload.error ??
          `markdown.new gagal (${response.status}) untuk URL: ${url}`,
      );
    }

    return {
      title: normalizeWhitespace(payload.title ?? "") || "Untitled",
      content: payload.content,
      method: payload.method ?? method,
      tokens: payload.tokens ?? tokens,
    };
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `markdown.new gagal (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  return {
    title: normalizeWhitespace(titleMatch?.[1] ?? "") || "Untitled",
    content: text,
    method,
    tokens,
  };
}

async function fetchMarkdownFromDefuddle(url: string): Promise<{
  title: string;
  content: string;
  method: string;
  tokens: number | null;
}> {
  const endpoint = buildDefuddleFetchUrl(url);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "text/markdown, text/plain;q=0.9",
    },
    signal: AbortSignal.timeout(MARKDOWN_NEW_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `defuddle.md gagal (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const parsedUrl = new URL(url);
  const fallbackTitle = normalizeWhitespace(parsedUrl.hostname) || "Untitled";
  const title = parseDefuddleTitleFromMarkdown(text) ?? fallbackTitle;

  return {
    title,
    content: text,
    method: "defuddle-md",
    tokens: null,
  };
}

async function writeMarkResultFiles(
  url: string,
  outputRoot: string,
  fetched: {
    title: string;
    content: string;
    method: string;
    tokens: number | null;
  },
  outputVariant: string,
): Promise<MarkExtractResult> {
  const parsedUrl = new URL(url);
  const site = parsedUrl.hostname.toLowerCase();
  const titleSlug = slugify(fetched.title);
  const timestamp = toTimestampSlug();
  const outputDir = `${outputRoot}/sites/${site}/${titleSlug}/${outputVariant}/${timestamp}`;
  await mkdir(outputDir, { recursive: true });

  const names = buildArticleOutputFileNames(fetched.title);
  const markdownPath = `${outputDir}/${names.markdownFileName}`;
  const textPath = `${outputDir}/${names.textFileName}`;
  const metaPath = `${outputDir}/${names.metaFileName}`;

  const normalizedContent = fetched.content.trimEnd();
  await Bun.write(markdownPath, `${normalizedContent}\n`);
  await Bun.write(textPath, `${normalizedContent}\n`);
  await Bun.write(
    metaPath,
    `${JSON.stringify(
      {
        url,
        title: fetched.title,
        method: fetched.method,
        tokens: fetched.tokens,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return {
    url,
    title: fetched.title,
    method: fetched.method,
    tokens: fetched.tokens,
    outputDir,
    markdownPath,
    textPath,
    metaPath,
  };
}

export async function extractWithMarkdownNew(
  url: string,
  outputRoot: string,
): Promise<MarkExtractResult> {
  const fetched = await fetchMarkdownFromMarkdownNew(url);
  return writeMarkResultFiles(url, outputRoot, fetched, "markdown-new");
}

export async function extractWithDefuddle(
  url: string,
  outputRoot: string,
): Promise<MarkExtractResult> {
  const fetched = await fetchMarkdownFromDefuddle(url);
  return writeMarkResultFiles(url, outputRoot, fetched, "defuddle-md");
}
