type LogLevel = "info" | "warn" | "error" | "debug";

type LogContext = Record<string, string | number | boolean | null | undefined>;

type FormatLogLineInput = {
  level: LogLevel;
  component: string;
  message: string;
  context?: LogContext;
  error?: unknown;
  now?: Date;
};

function normalizeError(error: unknown): string | null {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    const stackLine = error.stack
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(1, 2)
      .join(" | ");
    return stackLine ? `${error.message} | ${stackLine}` : error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "unknown-error";
  }
}

function formatContext(context: LogContext | undefined): string {
  if (!context) {
    return "";
  }

  const entries = Object.entries(context).filter(
    ([, value]) => value !== undefined,
  );

  if (entries.length === 0) {
    return "";
  }

  const rendered = entries
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return ` ${rendered}`;
}

function levelTag(level: LogLevel): string {
  return level.toUpperCase();
}

export function formatLogLine(input: FormatLogLineInput): string {
  const timestamp = (input.now ?? new Date()).toISOString();
  const context = formatContext(input.context);
  const errorText = normalizeError(input.error);
  const errorPart = errorText ? ` error=${errorText}` : "";

  return `${timestamp} [${levelTag(input.level)}] [${input.component}] ${input.message}${context}${errorPart}`;
}

export function createLogger(component: string) {
  async function write(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): Promise<void> {
    const line = formatLogLine({
      level,
      component,
      message,
      context,
      error,
    });
    const stream = level === "error" ? Bun.stderr : Bun.stdout;
    await Bun.write(stream, `${line}\n`);
  }

  return {
    info: (message: string, context?: LogContext) =>
      write("info", message, context),
    warn: (message: string, context?: LogContext) =>
      write("warn", message, context),
    debug: (message: string, context?: LogContext) =>
      write("debug", message, context),
    error: (message: string, error?: unknown, context?: LogContext) =>
      write("error", message, context, error),
  };
}
