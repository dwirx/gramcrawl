import { parseCliArgs, formatCliError } from "./cli/parse-args";
import {
  extractCookieHeaderFromAnyFormat,
  hasCookieName,
  writeCookieToEnv,
} from "./cli/cookie-env";
import { runExtraction } from "./app/extract-service";
import { readManifest } from "./app/run-store";
import { createApiServer } from "./app/server";
import {
  downloadSubtitlesAndConvert,
  listAvailableSubtitles,
  pickPreferredSubtitleLanguages,
  resolveOriginalLanguage,
} from "./subtitle/service";
import { runScribdBrowserDownload } from "./scribd/browser-download";

async function writeLine(value: string): Promise<void> {
  await Bun.write(Bun.stdout, `${value}\n`);
}

function isSubtitleTimestampEnabled(): boolean {
  return (process.env.EXTRACT_SUBTITLE_TIMESTAMP ?? "1").trim() !== "0";
}

function renderAllLanguageCodes(
  languages: Array<{ code: string; hasManual: boolean; hasAuto: boolean }>,
): string {
  if (languages.length === 0) {
    return "-";
  }

  const rendered = languages.map((language) => {
    const mode = language.hasManual ? "M" : language.hasAuto ? "A" : "?";
    return `${language.code}[${mode}]`;
  });

  const limited = rendered.slice(0, 12);
  const suffix =
    rendered.length > limited.length
      ? `, +${rendered.length - limited.length} lainnya`
      : "";
  return `${limited.join(", ")}${suffix}`;
}

async function runCli(argv: string[]): Promise<void> {
  const command = parseCliArgs(argv);

  if (command.command === "extract") {
    const extraction = await runExtraction({
      rootUrl: command.url,
      maxPages: command.maxPages,
      outputRoot: command.outputRoot,
    });

    await writeLine(`Run ID: ${extraction.runId}`);
    await writeLine(`Site: ${extraction.site}`);
    await writeLine(`Crawled pages: ${extraction.result.crawledPages}`);
    await writeLine(`Markdown files: ${extraction.markdownFiles.length}`);
    await writeLine(`Text files: ${extraction.textFiles.length}`);
    await writeLine(`Result JSON: ${extraction.resultFile}`);
    return;
  }

  if (command.command === "scribd") {
    const hostname = new URL(command.url).hostname.toLowerCase();
    if (hostname !== "scribd.com" && !hostname.endsWith(".scribd.com")) {
      throw new Error(
        "Command scribd hanya untuk URL Scribd. Gunakan command extract untuk domain lain.",
      );
    }

    const extraction = await runExtraction({
      rootUrl: command.url,
      maxPages: 1,
      outputRoot: command.outputRoot,
    });

    await writeLine(`Run ID: ${extraction.runId}`);
    await writeLine(`Site: ${extraction.site}`);
    await writeLine(`Crawled pages: ${extraction.result.crawledPages}`);
    await writeLine(`Markdown files: ${extraction.markdownFiles.length}`);
    await writeLine(`Text files: ${extraction.textFiles.length}`);
    await writeLine(`Result JSON: ${extraction.resultFile}`);
    return;
  }

  if (command.command === "scribd-browser") {
    await writeLine(
      `Membuka browser Scribd (mode login manual). Format target: ${command.format}. Setelah login, sistem akan klik download otomatis jika tombol tersedia.`,
    );

    const downloaded = await runScribdBrowserDownload({
      url: command.url,
      outputRoot: command.outputRoot,
      waitMs: command.waitMs,
      format: command.format,
    });

    await writeLine(`File: ${downloaded.fileName}`);
    await writeLine(`Saved: ${downloaded.savedPath}`);
    await writeLine(`Output dir: ${downloaded.outputDir}`);
    return;
  }

  if (command.command === "list") {
    const runs = await readManifest(command.outputRoot);
    const displayed = runs.slice(0, command.limit);

    if (displayed.length === 0) {
      await writeLine("Belum ada history extract.");
      return;
    }

    for (const run of displayed) {
      await writeLine(
        `${run.id} | site=${run.site} | pages=${run.crawledPages} | md=${run.articleFiles} | ${run.rootUrl}`,
      );
    }

    return;
  }

  if (command.command === "cookie-import") {
    const raw = await Bun.file(command.cookiesFile).text();
    const cookie = extractCookieHeaderFromAnyFormat(raw, command.domain);

    if (!cookie) {
      throw new Error(
        `Cookie tidak ditemukan untuk domain ${command.domain} di file ${command.cookiesFile}`,
      );
    }

    const updated = await writeCookieToEnv(
      command.envPath,
      command.domain,
      cookie,
    );
    await writeLine(
      `Cookie domain ${updated.domain} tersimpan ke ${updated.envPath}`,
    );
    await writeLine(
      `Panjang cookie: ${cookie.length} karakter. Langsung aktif di process ini.`,
    );
    if (!hasCookieName(cookie, "cf_clearance")) {
      await writeLine(
        "Peringatan: cookie ini belum berisi cf_clearance. Untuk situs Cloudflare, extract kemungkinan tetap gagal.",
      );
    }
    return;
  }

  if (command.command === "cookie-set") {
    const updated = await writeCookieToEnv(
      command.envPath,
      command.domain,
      command.cookie,
    );
    await writeLine(
      `Cookie domain ${updated.domain} tersimpan ke ${updated.envPath}`,
    );
    await writeLine("Cookie langsung aktif di process ini.");
    if (!hasCookieName(command.cookie, "cf_clearance")) {
      await writeLine(
        "Peringatan: cookie ini belum berisi cf_clearance. Untuk situs Cloudflare, extract kemungkinan tetap gagal.",
      );
    }
    return;
  }

  if (command.command === "subtitle") {
    if (!command.lang) {
      const listed = await listAvailableSubtitles(command.url);
      const resolvedOriginal = resolveOriginalLanguage(
        listed.languages,
        listed.originalLanguage,
      );
      const preferred = pickPreferredSubtitleLanguages(
        listed.languages,
        resolvedOriginal,
      );
      await writeLine(`Title: ${listed.title}`);
      await writeLine(`Source: ${listed.webpageUrl}`);
      await writeLine(`Extractor: ${listed.extractorKey}`);
      await writeLine(`Original language: ${resolvedOriginal ?? "-"}`);

      if (preferred.length === 0) {
        await writeLine("Subtitle tidak tersedia.");
        return;
      }

      await writeLine("Subtitle pilihan (original/en/id):");
      for (const language of preferred) {
        const mode = language.hasManual
          ? "manual"
          : language.hasAuto
            ? "auto"
            : "unknown";
        await writeLine(`- ${language.code} (${mode})`);
      }
      await writeLine(
        `Bahasa YouTube tersedia: ${renderAllLanguageCodes(listed.languages)}`,
      );
      if (listed.languages.length > preferred.length) {
        await writeLine(
          `Bahasa lain disembunyikan: ${listed.languages.length - preferred.length}`,
        );
      }
      await writeLine("Gunakan --lang <kode> untuk download subtitle.");
      return;
    }

    const downloaded = await downloadSubtitlesAndConvert(
      command.url,
      command.lang,
      command.outputRoot,
      { includeTimestamp: isSubtitleTimestampEnabled() },
    );
    await writeLine(`Title: ${downloaded.title}`);
    await writeLine(`Language: ${downloaded.language}`);
    await writeLine(`Output: ${downloaded.outputDir}`);
    await writeLine(`SRT: ${downloaded.srtPath ?? "-"}`);
    await writeLine(`VTT: ${downloaded.vttPath ?? "-"}`);
    await writeLine(`TXT: ${downloaded.txtPath}`);
    await writeLine(`MD: ${downloaded.mdPath}`);
    await writeLine(
      `Timestamp: ${isSubtitleTimestampEnabled() ? "ON" : "OFF"}`,
    );
    return;
  }

  const app = createApiServer(command.outputRoot).listen(command.port);
  await writeLine(`API server running at http://localhost:${app.server?.port}`);
}

if (import.meta.main) {
  try {
    await runCli(process.argv);
  } catch (error) {
    await Bun.write(Bun.stderr, `${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}

export { runCli };
