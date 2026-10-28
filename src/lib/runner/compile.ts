import type { ArtifactLanguage } from "@/lib/schemas";

/** TSX/JSX to ES module JavaScript (types stripped, automatic JSX runtime, imports kept). */
export async function compileReact(source: string, language: ArtifactLanguage): Promise<string> {
  const { transform } = await import("sucrase");
  const transforms: ("typescript" | "jsx")[] = language === "tsx" ? ["typescript", "jsx"] : ["jsx"];
  return transform(source, { transforms, jsxRuntime: "automatic", production: true }).code;
}

/** Line and column (1-based) of a compiler error, when its message carries them. */
export function compileErrorPosition(error: unknown): { line: number; column: number } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\((\d+):(\d+)\)/.exec(message);
  return match === null ? null : { line: Number(match[1]), column: Number(match[2]) + 1 };
}
