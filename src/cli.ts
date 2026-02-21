import { parseCliArgs, formatCliError } from "./cli/parse-args";
import {
  extractCookieHeaderFromNetscape,
  hasCookieName,
  writeCookieToEnv,
} from "./cli/cookie-env";
import { runExtraction } from "./app/extract-service";
import { readManifest } from "./app/run-store";
import { createApiServer } from "./app/server";

async function writeLine(value: string): Promise<void> {
  await Bun.write(Bun.stdout, `${value}\n`);
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
    const cookie = extractCookieHeaderFromNetscape(raw, command.domain);

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
