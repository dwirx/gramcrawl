import type { ContentBlock } from "./types";

export type RenderedFallbackArticle = {
  articleTitle: string;
  description: string;
  articleBodyText: string;
  contentBlocks: ContentBlock[];
  imageCount: number;
  publishedAt: string | null;
};

function createRequestSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timeout (${timeoutMs}ms)`));
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason ?? new Error("Aborted"));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function cleanMarkdownLine(line: string): string {
  return normalizeWhitespace(
    line
      .replaceAll(/^#{1,6}\s*/g, "")
      .replaceAll(/^[-*_]{3,}$/g, "")
      .replaceAll(/\[(.*?)\]\((.*?)\)/g, "$1"),
  );
}

export function parseRenderedFallbackDocument(
  rawText: string,
): RenderedFallbackArticle | null {
  const titleMatch = rawText.match(/^Title:\s*(.+)$/m);
  const markdownMarker = "Markdown Content:";
  const markerIndex = rawText.indexOf(markdownMarker);

  if (markerIndex === -1) {
    return null;
  }

  let articleTitle = normalizeWhitespace(titleMatch?.[1] ?? "");
  const markdownPart = rawText
    .slice(markerIndex + markdownMarker.length)
    .trim();
  const lines = markdownPart.split(/\r?\n/);

  const contentBlocks: ContentBlock[] = [];
  let paragraphBuffer: string[] = [];

  const flushParagraph = (): void => {
    const text = cleanMarkdownLine(paragraphBuffer.join(" "));

    if (text) {
      contentBlocks.push({ type: "text", tag: "p", text });
    }

    paragraphBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    const imageMatch = line.match(/^!\[(.*?)\]\((.*?)\)$/);
    const linkedImageMatch = line.match(/^\[!\[(.*?)\]\((.*?)\)\]\((.*?)\)$/);

    if (imageMatch) {
      flushParagraph();
      const alt = normalizeWhitespace(imageMatch[1] ?? "") || "image";
      const src = normalizeWhitespace(imageMatch[2] ?? "");

      if (src) {
        contentBlocks.push({
          type: "image",
          src,
          alt,
          caption: "",
        });
      }
      continue;
    }

    if (linkedImageMatch) {
      flushParagraph();
      const alt = normalizeWhitespace(linkedImageMatch[1] ?? "") || "image";
      const src = normalizeWhitespace(linkedImageMatch[2] ?? "");
      const caption = normalizeWhitespace(linkedImageMatch[3] ?? "");

      if (src) {
        contentBlocks.push({
          type: "image",
          src,
          alt,
          caption,
        });
      }
      continue;
    }

    if (/^[-=*]{3,}$/.test(line) || line === "Loading diagram...") {
      flushParagraph();
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();

  const textBlocks = contentBlocks.filter(
    (block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text",
  );

  if (!articleTitle) {
    const heading = markdownPart.match(/^#{1,6}\s*(.+)$/m)?.[1] ?? "";
    articleTitle = normalizeWhitespace(heading);
  }

  if (!articleTitle || textBlocks.length === 0) {
    return null;
  }

  const articleBodyText = textBlocks.map((block) => block.text).join("\n\n");
  const description = textBlocks[0]?.text ?? "";

  return {
    articleTitle,
    description,
    articleBodyText,
    contentBlocks,
    imageCount: contentBlocks.filter((block) => block.type === "image").length,
    publishedAt: null,
  };
}

export async function fetchRenderedFallbackArticle(
  url: string,
  options?: { signal?: AbortSignal },
): Promise<RenderedFallbackArticle | null> {
  const { signal, cleanup } = createRequestSignal(20_000, options?.signal);
  const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
  try {
    const response = await fetch(proxyUrl, {
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const rawText = await response.text();
    return parseRenderedFallbackDocument(rawText);
  } catch {
    if (options?.signal?.aborted) {
      throw new Error("Extraction cancelled by user");
    }
    return null;
  } finally {
    cleanup();
  }
}
