export type ContentTextBlock = {
  type: "text";
  tag: string;
  text: string;
};

export type ContentImageBlock = {
  type: "image";
  src: string;
  alt: string;
  caption: string;
};

export type ContentBlock = ContentTextBlock | ContentImageBlock;

export type ExtractedImage = {
  src: string;
  alt: string;
  caption: string;
  order: number;
  blockOrder: number;
};

export type ExtractedPage = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  links: string[];
  articleTitle: string;
  articleBodyText: string;
  contentBlocks: ContentBlock[];
  images: ExtractedImage[];
  imageCount: number;
  publishedAt: string | null;
  isArticlePage: boolean;
  markdownPath: string | null;
};

export type ExtractionResult = {
  rootUrl: string;
  maxPages: number;
  crawledPages: number;
  collectedAt: string;
  pages: ExtractedPage[];
};
