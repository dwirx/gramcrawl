import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type SubtitleLanguage = {
  code: string;
  hasManual: boolean;
  hasAuto: boolean;
};

export type SubtitleListResult = {
  title: string;
  webpageUrl: string;
  extractorKey: string;
  originalLanguage: string | null;
  languages: SubtitleLanguage[];
};

export type SubtitleDownloadResult = {
  title: string;
  language: string;
  site: string;
  outputDir: string;
  srtPath: string | null;
  vttPath: string | null;
  txtPath: string;
  mdPath: string;
};

export type SubtitleRenderOptions = {
  includeTimestamp?: boolean;
};

type YtDlpMetadata = {
  title?: string;
  webpage_url?: string;
  extractor_key?: string;
  language?: string;
  subtitles?: Record<string, unknown[]>;
  automatic_captions?: Record<string, unknown[]>;
};

const LIST_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_SUBTITLE_FILE_BYTES = 10 * 1024 * 1024;
const TITLE_MAX_LENGTH = 120;
const TIMESTAMP_LINE_LIMIT = 4_000;

type SubtitleCue = {
  start: string;
  text: string;
};

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

  const safe = normalized || "untitled";
  return safe.slice(0, TITLE_MAX_LENGTH);
}

function buildSiteFolderName(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replaceAll(/[^a-z0-9.-]/g, "-");
  } catch {
    return "unknown-site";
  }
}

function toTimestampSlug(now = new Date()): string {
  return now
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("T", "_");
}

function stripHtmlTags(value: string): string {
  return value.replaceAll(/<[^>]*>/g, "");
}

function toReadableTimestamp(value: string): string {
  const normalized = value.replaceAll(",", ".");
  const [clockPart] = normalized.split(".");
  const clock = clockPart ?? "";
  const parts = clock.split(":");

  if (parts.length === 3) {
    return clock;
  }

  if (parts.length === 2) {
    return `00:${clock}`;
  }

  return "00:00:00";
}

function extractSrtCues(raw: string): SubtitleCue[] {
  const lines = raw.replaceAll(/\r\n/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let currentTimestamp = "";
  let currentTextLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (currentTimestamp && currentTextLines.length > 0) {
        cues.push({
          start: currentTimestamp,
          text: normalizeWhitespace(stripHtmlTags(currentTextLines.join(" "))),
        });
      }
      currentTimestamp = "";
      currentTextLines = [];
      continue;
    }

    if (/^\d+$/.test(trimmed)) {
      continue;
    }

    const timeMatch = trimmed.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/,
    );
    if (timeMatch?.[1]) {
      currentTimestamp = toReadableTimestamp(timeMatch[1]);
      currentTextLines = [];
      continue;
    }

    if (currentTimestamp) {
      currentTextLines.push(trimmed);
    }
  }

  if (currentTimestamp && currentTextLines.length > 0) {
    cues.push({
      start: currentTimestamp,
      text: normalizeWhitespace(stripHtmlTags(currentTextLines.join(" "))),
    });
  }

  return cues.filter((cue) => cue.text.length > 0);
}

function extractVttCues(raw: string): SubtitleCue[] {
  const lines = raw.replaceAll(/\r\n/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let currentTimestamp = "";
  let currentTextLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (currentTimestamp && currentTextLines.length > 0) {
        cues.push({
          start: currentTimestamp,
          text: normalizeWhitespace(stripHtmlTags(currentTextLines.join(" "))),
        });
      }
      currentTimestamp = "";
      currentTextLines = [];
      continue;
    }

    if (
      trimmed === "WEBVTT" ||
      trimmed.startsWith("NOTE") ||
      trimmed.startsWith("STYLE") ||
      trimmed.startsWith("Kind:") ||
      trimmed.startsWith("Language:")
    ) {
      continue;
    }

    const timeMatch = trimmed.match(
      /^((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/,
    );
    if (timeMatch?.[1]) {
      currentTimestamp = toReadableTimestamp(timeMatch[1]);
      currentTextLines = [];
      continue;
    }

    if (currentTimestamp) {
      currentTextLines.push(trimmed);
    }
  }

  if (currentTimestamp && currentTextLines.length > 0) {
    cues.push({
      start: currentTimestamp,
      text: normalizeWhitespace(stripHtmlTags(currentTextLines.join(" "))),
    });
  }

  return cues.filter((cue) => cue.text.length > 0);
}

function normalizeCues(rawCues: SubtitleCue[]): SubtitleCue[] {
  const limitedCues = rawCues.slice(0, TIMESTAMP_LINE_LIMIT);
  const out: SubtitleCue[] = [];
  let previousText = "";
  let previousTimestamp = "";

  for (const cue of limitedCues) {
    const text = normalizeWhitespace(cue.text);
    const timestamp = normalizeWhitespace(cue.start);
    if (!text || !timestamp) {
      continue;
    }
    if (text === previousText && timestamp === previousTimestamp) {
      continue;
    }
    out.push({ start: timestamp, text });
    previousText = text;
    previousTimestamp = timestamp;
  }

  return out;
}

function normalizeTranscript(raw: string): string {
  const lines = raw.replaceAll(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let previous = "";
  let blankCount = 0;

  for (const line of lines) {
    const cleaned = normalizeWhitespace(line);

    if (!cleaned) {
      blankCount += 1;
      if (blankCount <= 1 && out.length > 0) {
        out.push("");
      }
      continue;
    }

    blankCount = 0;
    if (cleaned === previous) {
      continue;
    }

    out.push(cleaned);
    previous = cleaned;
  }

  return `${out.join("\n").trim()}\n`;
}

function cuesToTimestampText(cues: SubtitleCue[]): string {
  if (cues.length === 0) {
    return "";
  }

  return `${cues.map((cue) => `[${cue.start}] ${cue.text}`).join("\n")}\n`;
}

function cuesToPlainText(cues: SubtitleCue[]): string {
  if (cues.length === 0) {
    return "";
  }
  return normalizeTranscript(cues.map((cue) => cue.text).join("\n"));
}

export function parseSrtToTimestampText(raw: string): string {
  const cues = normalizeCues(extractSrtCues(raw));
  return cuesToTimestampText(cues);
}

export function parseVttToTimestampText(raw: string): string {
  const cues = normalizeCues(extractVttCues(raw));
  return cuesToTimestampText(cues);
}

function parseSrtToPlainText(raw: string): string {
  const cues = normalizeCues(extractSrtCues(raw));
  return cuesToPlainText(cues);
}

function parseVttToPlainText(raw: string): string {
  const cues = normalizeCues(extractVttCues(raw));
  return cuesToPlainText(cues);
}

function buildMarkdownFromText(
  title: string,
  source: string,
  language: string,
  transcript: string,
  timestampTranscript: string,
  includeTimestamp: boolean,
): string {
  const sections = ["## Transcript", "", transcript.trim(), ""];

  if (includeTimestamp) {
    sections.push(
      "## Transcript With Timestamp",
      "",
      timestampTranscript.trim(),
      "",
    );
  }

  return [
    "================================================================================",
    `TITLE: ${title}`,
    `SOURCE: ${source}`,
    `LANGUAGE: ${language}`,
    "================================================================================",
    "",
    `# ${title}`,
    "",
    `Source: ${source}`,
    "",
    `Language: ${language}`,
    "",
    ...sections,
    "",
  ].join("\n");
}

function buildTextFromText(
  title: string,
  source: string,
  language: string,
  transcript: string,
  timestampTranscript: string,
  includeTimestamp: boolean,
): string {
  return buildMarkdownFromText(
    title,
    source,
    language,
    transcript,
    timestampTranscript,
    includeTimestamp,
  );
}

function resolveYtDlpBinary(): string {
  const configured = process.env.EXTRACT_YT_DLP_BIN?.trim();
  if (configured) {
    return configured;
  }

  const localBinary = ".cache/bin/yt-dlp";
  return existsSync(localBinary) ? localBinary : "yt-dlp";
}

async function runYtDlp(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const binary = resolveYtDlpBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Gagal menjalankan yt-dlp (${binary}): ${error.message}. Set EXTRACT_YT_DLP_BIN jika lokasi binary berbeda.`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function parseLanguages(meta: YtDlpMetadata): SubtitleLanguage[] {
  const manual = new Set(Object.keys(meta.subtitles ?? {}));
  const auto = new Set(Object.keys(meta.automatic_captions ?? {}));
  const all = Array.from(new Set([...manual, ...auto]))
    .map((code) => code.trim())
    .filter(Boolean);

  const normalized = all.map((code) => ({
    code,
    hasManual: manual.has(code),
    hasAuto: auto.has(code),
  }));

  return sortSubtitleLanguages(normalized);
}

export function sortSubtitleLanguages(
  languages: SubtitleLanguage[],
): SubtitleLanguage[] {
  return [...languages].sort((a, b) => {
    const aPriority = a.hasManual ? 0 : a.hasAuto ? 1 : 2;
    const bPriority = b.hasManual ? 0 : b.hasAuto ? 1 : 2;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return a.code.localeCompare(b.code);
  });
}

function normalizeLanguageCode(value: string): string {
  return value.replaceAll("_", "-").trim();
}

function languageBase(value: string): string {
  return normalizeLanguageCode(value).split("-")[0]?.toLowerCase() ?? "";
}

function findLanguageInAvailable(
  available: SubtitleLanguage[],
  target: string,
): SubtitleLanguage | null {
  const normalizedTarget = normalizeLanguageCode(target);
  const exactMatch =
    available.find(
      (item) => normalizeLanguageCode(item.code) === normalizedTarget,
    ) ?? null;
  if (exactMatch) {
    return exactMatch;
  }

  const targetBase = languageBase(normalizedTarget);
  if (!targetBase) {
    return null;
  }

  return (
    available.find((item) => languageBase(item.code) === targetBase) ?? null
  );
}

export function pickPreferredSubtitleLanguages(
  available: SubtitleLanguage[],
  originalLanguage: string | null,
): SubtitleLanguage[] {
  const preferred: SubtitleLanguage[] = [];
  const seen = new Set<string>();

  const pushIfFound = (target: string | null): void => {
    if (!target) {
      return;
    }

    const found = findLanguageInAvailable(available, target);
    if (!found) {
      return;
    }

    const key = normalizeLanguageCode(found.code);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    preferred.push(found);
  };

  pushIfFound(originalLanguage);
  pushIfFound("en");
  pushIfFound("id");

  if (preferred.length > 0) {
    return preferred;
  }

  return available.slice(0, 3);
}

export function resolveOriginalLanguage(
  available: SubtitleLanguage[],
  originalLanguage: string | null,
): string | null {
  const explicit = findLanguageInAvailable(available, originalLanguage ?? "");
  if (explicit) {
    return explicit.code;
  }

  const manual = available.find((language) => language.hasManual);
  if (manual) {
    return manual.code;
  }

  return available[0]?.code ?? null;
}

export async function listAvailableSubtitles(
  url: string,
): Promise<SubtitleListResult> {
  const result = await runYtDlp(
    ["--skip-download", "--dump-single-json", "--no-warnings", url],
    LIST_TIMEOUT_MS,
  );

  if (result.code !== 0) {
    throw new Error(
      `yt-dlp list subtitle gagal: ${result.stderr || result.stdout}`,
    );
  }

  let parsed: YtDlpMetadata;
  try {
    parsed = JSON.parse(result.stdout) as YtDlpMetadata;
  } catch {
    throw new Error("Gagal parse metadata subtitle dari yt-dlp");
  }

  const title = normalizeWhitespace(parsed.title ?? "Untitled Video");
  const webpageUrl = normalizeWhitespace(parsed.webpage_url ?? url);
  const extractorKey = normalizeWhitespace(parsed.extractor_key ?? "unknown");
  const originalLanguage = parsed.language
    ? normalizeLanguageCode(parsed.language)
    : null;
  const languages = parseLanguages(parsed);

  return {
    title,
    webpageUrl,
    extractorKey,
    originalLanguage,
    languages,
  };
}

async function ensureFileWithinLimit(path: string): Promise<void> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`File subtitle tidak ditemukan: ${path}`);
  }

  const info = await stat(path);
  if (info.size > MAX_SUBTITLE_FILE_BYTES) {
    throw new Error(`File subtitle terlalu besar: ${path}`);
  }
}

async function downloadFormat(
  url: string,
  language: string,
  subFormat: "srt" | "vtt",
  baseDir: string,
  baseSlug: string,
): Promise<void> {
  const args = [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    language,
    "--sub-format",
    subFormat,
    "-P",
    `home:${baseDir}`,
    "-o",
    `${baseSlug}.%(ext)s`,
    "--no-warnings",
    "--restrict-filenames",
    url,
  ];

  const result = await runYtDlp(args, DOWNLOAD_TIMEOUT_MS);

  if (result.code !== 0) {
    throw new Error(
      `yt-dlp download subtitle ${subFormat} gagal: ${result.stderr || result.stdout}`,
    );
  }
}

async function pickDownloadedSubtitleFile(
  dir: string,
  extension: "srt" | "vtt",
): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.toLowerCase().endsWith(`.${extension}`),
    )
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const selected = files[0];
  return selected ? `${dir}/${selected}` : null;
}

export async function downloadSubtitlesAndConvert(
  url: string,
  language: string,
  outputRoot: string,
  options?: SubtitleRenderOptions,
): Promise<SubtitleDownloadResult> {
  const includeTimestamp = options?.includeTimestamp ?? true;
  const listed = await listAvailableSubtitles(url);
  const site = buildSiteFolderName(url);
  const titleSlug = slugify(listed.title);
  const timestamp = toTimestampSlug();
  const outputDir = `${outputRoot}/sites/${site}/${titleSlug}/subtitles/${timestamp}`;
  await mkdir(outputDir, { recursive: true });

  await downloadFormat(url, language, "srt", outputDir, titleSlug);
  await downloadFormat(url, language, "vtt", outputDir, titleSlug);

  let srtPath = await pickDownloadedSubtitleFile(outputDir, "srt");
  let vttPath = await pickDownloadedSubtitleFile(outputDir, "vtt");

  if (!srtPath && !vttPath) {
    throw new Error(
      `Subtitle bahasa ${language} tidak ditemukan setelah download`,
    );
  }

  const finalSrtPath = `${outputDir}/${titleSlug}.${language}.srt`;
  const finalVttPath = `${outputDir}/${titleSlug}.${language}.vtt`;

  if (srtPath) {
    await rename(srtPath, finalSrtPath).catch(() => {});
    srtPath = finalSrtPath;
    await ensureFileWithinLimit(srtPath);
  }

  if (vttPath) {
    await rename(vttPath, finalVttPath).catch(() => {});
    vttPath = finalVttPath;
    await ensureFileWithinLimit(vttPath);
  }

  const transcriptSource = srtPath
    ? await Bun.file(srtPath).text()
    : await Bun.file(vttPath as string).text();
  const transcript = srtPath
    ? parseSrtToPlainText(transcriptSource)
    : parseVttToPlainText(transcriptSource);
  const timestampTranscript = srtPath
    ? parseSrtToTimestampText(transcriptSource)
    : parseVttToTimestampText(transcriptSource);

  const txtPath = `${outputDir}/${titleSlug}.${language}.txt`;
  const mdPath = `${outputDir}/${titleSlug}.${language}.md`;
  await Bun.write(
    txtPath,
    buildTextFromText(
      listed.title,
      listed.webpageUrl,
      language,
      transcript,
      timestampTranscript,
      includeTimestamp,
    ),
  );
  await Bun.write(
    mdPath,
    buildMarkdownFromText(
      listed.title,
      listed.webpageUrl,
      language,
      transcript,
      timestampTranscript,
      includeTimestamp,
    ),
  );

  const resolvedSrt = srtPath ?? null;
  const resolvedVtt = vttPath ?? null;

  await Bun.write(
    `${outputDir}/meta.json`,
    `${JSON.stringify(
      {
        title: listed.title,
        url: listed.webpageUrl,
        language,
        files: {
          srt: resolvedSrt,
          vtt: resolvedVtt,
          txt: txtPath,
          md: mdPath,
        },
        options: {
          includeTimestamp,
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return {
    title: listed.title,
    language,
    site,
    outputDir,
    srtPath: resolvedSrt,
    vttPath: resolvedVtt,
    txtPath,
    mdPath,
  };
}
