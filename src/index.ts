import { runCli } from "./cli";

const KNOWN_COMMANDS = new Set([
  "extract",
  "scribd",
  "scribd-browser",
  "subtitle",
  "list",
  "serve",
  "cookie-import",
  "cookie-set",
]);

function normalizeLegacyArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const firstArg = args[0];

  if (firstArg && KNOWN_COMMANDS.has(firstArg)) {
    return argv;
  }

  // Legacy mode: bun run src/index.ts <url?> <maxPages?>
  const rootUrl = args[0] ?? "https://cheerio.js.org/docs/";
  const maxPages = args[1] ?? "10";

  return [
    argv[0] ?? "bun",
    argv[1] ?? "src/index.ts",
    "extract",
    rootUrl,
    maxPages,
  ];
}

if (import.meta.main) {
  await runCli(normalizeLegacyArgs(process.argv));
}

export { normalizeLegacyArgs };
