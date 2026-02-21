import { ZodError } from "zod";
import {
  CliCommandSchema,
  CookieImportCommandSchema,
  CookieSetCommandSchema,
  ExtractCommandSchema,
  ListCommandSchema,
  ServeCommandSchema,
  SubtitleCommandSchema,
  type CliCommand,
} from "./schema";

function getFlagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (!token || !names.includes(token)) {
      continue;
    }

    return args[i + 1];
  }

  return undefined;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.slice(2);
  const command = args[0] ?? "extract";

  if (command === "extract") {
    const url = args[1] ?? "https://cheerio.js.org/docs/";
    const positionalMaxPages = args[2];
    const maxPages =
      getFlagValue(args, ["--max-pages", "-m"]) ?? positionalMaxPages;
    const outputRoot = getFlagValue(args, ["--out", "-o"]);

    return ExtractCommandSchema.parse({
      command,
      url,
      maxPages,
      outputRoot,
    });
  }

  if (command === "list") {
    const limit = getFlagValue(args, ["--limit", "-l"]);
    const outputRoot = getFlagValue(args, ["--out", "-o"]);

    return ListCommandSchema.parse({
      command,
      limit,
      outputRoot,
    });
  }

  if (command === "serve") {
    const port = getFlagValue(args, ["--port", "-p"]);
    const outputRoot = getFlagValue(args, ["--out", "-o"]);

    return ServeCommandSchema.parse({
      command,
      port,
      outputRoot,
    });
  }

  if (command === "cookie-import") {
    const domain = args[1];
    const cookiesFile = args[2];
    const envPath = getFlagValue(args, ["--env", "-e"]);

    return CookieImportCommandSchema.parse({
      command,
      domain,
      cookiesFile,
      envPath,
    });
  }

  if (command === "cookie-set") {
    const domain = args[1];
    const cookie = args[2];
    const envPath = getFlagValue(args, ["--env", "-e"]);

    return CookieSetCommandSchema.parse({
      command,
      domain,
      cookie,
      envPath,
    });
  }

  if (command === "subtitle") {
    const url = args[1];
    const lang = getFlagValue(args, ["--lang", "-g"]);
    const outputRoot = getFlagValue(args, ["--out", "-o"]);

    return SubtitleCommandSchema.parse({
      command,
      url,
      lang,
      outputRoot,
    });
  }

  throw new Error(
    `Command tidak dikenali: ${command}. Gunakan: extract | subtitle | list | serve | cookie-import | cookie-set`,
  );
}

export function formatCliError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }

  return error instanceof Error
    ? error.message
    : "Terjadi error tidak diketahui";
}

export function isCliCommand(input: unknown): input is CliCommand {
  return CliCommandSchema.safeParse(input).success;
}
