import { readFile } from "node:fs/promises";

export function slugifyTitle(title: string): string {
  return title
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export async function buildSendFileNameForExtract(
  path: string,
  fallbackBaseName: string,
): Promise<string> {
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? "";

  if (fileName !== "latest.md" && fileName !== "latest.txt") {
    return fileName;
  }

  const dir = parts.slice(0, -1).join("/");
  try {
    const latestJson = await readFile(`${dir}/latest.json`, "utf8");
    const parsed = JSON.parse(latestJson);
    if (parsed.articleTitle) {
      const slug = slugifyTitle(parsed.articleTitle);
      const ext = fileName.split(".").at(-1);
      return `${slug}.${ext}`;
    }
  } catch {
    // ignore
  }

  const siteFolder = parts.at(-2);
  if (siteFolder && siteFolder !== "latest") {
    const ext = fileName.split(".").at(-1);
    return `${siteFolder}.${ext}`;
  }

  return fileName;
}

export function buildPdfHtml(rawText: string): string {
  const escaped = rawText
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: sans-serif; line-height: 1.6; white-space: pre-wrap; }
  </style>
</head>
<body>
${escaped}
</body>
</html>
  `.trim();
}
