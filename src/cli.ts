import { parseCliArgs, formatCliError } from "./cli/parse-args";
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
