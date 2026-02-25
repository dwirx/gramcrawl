import { z } from "zod";

const PositiveInt = z.coerce.number().int().positive();
const ScribdFormat = z.enum(["pdf", "docx", "txt"]);

export const ExtractCommandSchema = z.object({
  command: z.literal("extract"),
  url: z.url(),
  maxPages: PositiveInt.default(10),
  outputRoot: z.string().default("output"),
});

export const ScribdCommandSchema = z.object({
  command: z.literal("scribd"),
  url: z.url(),
  outputRoot: z.string().default("output"),
});

export const ScribdBrowserCommandSchema = z.object({
  command: z.literal("scribd-browser"),
  url: z.url(),
  waitMs: PositiveInt.default(300_000),
  format: ScribdFormat.default("pdf"),
  outputRoot: z.string().default("output"),
});

export const ListCommandSchema = z.object({
  command: z.literal("list"),
  limit: PositiveInt.default(20),
  outputRoot: z.string().default("output"),
});

export const ServeCommandSchema = z.object({
  command: z.literal("serve"),
  port: PositiveInt.default(3000),
  outputRoot: z.string().default("output"),
});

export const CookieImportCommandSchema = z.object({
  command: z.literal("cookie-import"),
  domain: z.string().min(1),
  cookiesFile: z.string().min(1),
  envPath: z.string().default(".env"),
});

export const CookieSetCommandSchema = z.object({
  command: z.literal("cookie-set"),
  domain: z.string().min(1),
  cookie: z.string().min(1),
  envPath: z.string().default(".env"),
});

export const SubtitleCommandSchema = z.object({
  command: z.literal("subtitle"),
  url: z.url(),
  lang: z.string().min(1).optional(),
  outputRoot: z.string().default("output"),
});

export const CliCommandSchema = z.discriminatedUnion("command", [
  ExtractCommandSchema,
  ScribdCommandSchema,
  ScribdBrowserCommandSchema,
  ListCommandSchema,
  ServeCommandSchema,
  CookieImportCommandSchema,
  CookieSetCommandSchema,
  SubtitleCommandSchema,
]);

export type ExtractCommand = z.infer<typeof ExtractCommandSchema>;
export type ScribdCommand = z.infer<typeof ScribdCommandSchema>;
export type ScribdBrowserCommand = z.infer<typeof ScribdBrowserCommandSchema>;
export type ListCommand = z.infer<typeof ListCommandSchema>;
export type ServeCommand = z.infer<typeof ServeCommandSchema>;
export type CookieImportCommand = z.infer<typeof CookieImportCommandSchema>;
export type CookieSetCommand = z.infer<typeof CookieSetCommandSchema>;
export type SubtitleCommand = z.infer<typeof SubtitleCommandSchema>;
export type CliCommand = z.infer<typeof CliCommandSchema>;
