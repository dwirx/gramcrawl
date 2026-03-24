import { z } from "zod";

export const BotConfigSchema = z.object({
  token: z.string().min(10),
  outputRoot: z.string().default("output"),
  envPath: z.string().default(".env"),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

export type PendingSubtitleSelection = {
  chatId: number;
  url: string;
  title: string;
  languages: Set<string>;
  bestLanguage: string | null;
  createdAt: number;
};

export type JobCancelToken = {
  isCancelled: () => boolean;
  signal: AbortSignal;
};

export type JobCancelRef = {
  cancelled: boolean;
  abortController: AbortController;
};

export type ChatJob = {
  id: string;
  label: string;
  createdAt: number;
  run: (token: JobCancelToken) => Promise<void>;
};

export type ChatQueueState = {
  running: ChatJob | null;
  runningCancelRef: JobCancelRef | null;
  queue: ChatJob[];
  startedAt: number;
};

export type ExtractCacheEntry = {
  key: string;
  rootUrl: string;
  maxPages: number;
  createdAt: number;
  expiresAt: number;
  extraction: {
    runId: string;
    site: string;
    resultFile: string;
    markdownFiles: string[];
    textFiles: string[];
    crawledPages: number;
  };
};
