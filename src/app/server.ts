import { Elysia } from "elysia";
import { z } from "zod";
import { runExtraction } from "./extract-service";
import { readManifest } from "./run-store";

const ExtractBodySchema = z.object({
  url: z.url(),
  maxPages: z.coerce.number().int().positive().default(10),
});

export function createApiServer(outputRoot: string) {
  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/runs", async () => {
      const runs = await readManifest(outputRoot);
      return { runs };
    })
    .post("/extract", async ({ body, set }) => {
      const parsed = ExtractBodySchema.safeParse(body);

      if (!parsed.success) {
        set.status = 400;
        return {
          error: "Invalid request body",
          details: parsed.error.issues,
        };
      }

      const extraction = await runExtraction(
        {
          rootUrl: parsed.data.url,
          maxPages: parsed.data.maxPages,
          outputRoot,
        },
        {
          includePagesInResponse: false,
        },
      );

      return {
        runId: extraction.runId,
        site: extraction.site,
        resultFile: extraction.resultFile,
        markdownFiles: extraction.markdownFiles,
        textFiles: extraction.textFiles,
        crawledPages: extraction.result.crawledPages,
      };
    });
}
