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

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_VALUE_MAX_LENGTH = 180;

function sanitizeLogValue(value: string): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= LOG_VALUE_MAX_LENGTH) {
    return compact;
  }

  const remaining = compact.length - LOG_VALUE_MAX_LENGTH;
  return `${compact.slice(0, LOG_VALUE_MAX_LENGTH)}...(truncated:${remaining})`;
}

export function resolveLogLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }

  return "info";
}

export function isLogLevelEnabled(
  level: LogLevel,
  minLevel: LogLevel,
): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[minLevel];
}

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
    const rendered = stackLine
      ? `${error.message} | ${stackLine}`
      : error.message;
    return sanitizeLogValue(rendered);
  }

  if (typeof error === "string") {
    return sanitizeLogValue(error);
  }

  try {
    return sanitizeLogValue(JSON.stringify(error));
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
    .map(([key, value]) => `${key}=${sanitizeLogValue(String(value))}`)
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
  const minLevel = resolveLogLevel(process.env.EXTRACT_LOG_LEVEL);

  async function write(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): Promise<void> {
    if (!isLogLevelEnabled(level, minLevel)) {
      return;
    }

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
