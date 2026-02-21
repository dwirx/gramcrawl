import type { ContentBlock, ExtractedImage } from "./types";

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function collectImagesFromBlocks(
  blocks: ContentBlock[],
): ExtractedImage[] {
  const images: ExtractedImage[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block.type !== "image") {
      continue;
    }

    const src = normalizeWhitespace(block.src);
    if (!src) {
      continue;
    }

    images.push({
      src,
      alt: normalizeWhitespace(block.alt),
      caption: normalizeWhitespace(block.caption),
      order: images.length + 1,
      blockOrder: index + 1,
    });
  }

  return images;
}
