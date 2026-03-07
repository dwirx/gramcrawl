import { describe, expect, test } from "bun:test";
import { runExtraction } from "./extract-service";

describe("runExtraction", () => {
  test("throws cancellation error when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const run = runExtraction(
      {
        rootUrl: "https://example.com/article",
        maxPages: 1,
        outputRoot: "output",
      },
      {
        signal: controller.signal,
      },
    );

    await expect(run).rejects.toThrow("Extraction cancelled by user");
  });
});
