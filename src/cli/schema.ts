import { z } from "zod";

const PositiveInt = z.coerce.number().int().positive();

export const ExtractCommandSchema = z.object({
  command: z.literal("extract"),
  url: z.url(),
  maxPages: PositiveInt.default(10),
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

export const CliCommandSchema = z.discriminatedUnion("command", [
  ExtractCommandSchema,
  ListCommandSchema,
  ServeCommandSchema,
]);

export type ExtractCommand = z.infer<typeof ExtractCommandSchema>;
export type ListCommand = z.infer<typeof ListCommandSchema>;
export type ServeCommand = z.infer<typeof ServeCommandSchema>;
export type CliCommand = z.infer<typeof CliCommandSchema>;
