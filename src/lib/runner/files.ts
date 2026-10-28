import type { ArtifactLanguage, ArtifactType } from "@/lib/schemas";

const EXTENSIONS: Readonly<Record<string, string>> = {
  html: "html",
  svg: "svg",
  xml: "svg",
  tsx: "tsx",
  jsx: "jsx",
  markdown: "md",
  md: "md",
  mermaid: "mmd",
  mmd: "mmd",
  py: "py",
  python: "py",
  typescript: "ts",
  ts: "ts",
  javascript: "js",
  js: "js",
};

const MIME_TYPES: Readonly<Record<ArtifactType, string>> = {
  html: "text/html",
  svg: "image/svg+xml",
  markdown: "text/markdown",
  react: "text/plain",
  mermaid: "text/plain",
  code: "text/plain",
};

/** A safe download file name: slugged title plus an extension for the language. */
export function artifactFileName(title: string, language: ArtifactLanguage): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const extension = EXTENSIONS[language] ?? (/^[a-z0-9]+$/.test(language) ? language : "txt");
  return `${slug || "artifact"}.${extension}`;
}

export function artifactMimeType(type: ArtifactType): string {
  return `${MIME_TYPES[type]};charset=utf-8`;
}
