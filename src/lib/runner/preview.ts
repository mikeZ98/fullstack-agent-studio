import {
  buildRunnerCsp,
  generateNonce,
  MERMAID_RUNNER_CONFIG,
  preprocessArtifact,
  RUNNER_SCRIPT_HOSTS,
} from "@/lib/core/sandbox-preprocessor";
import { inspectArtifact, isBlocking } from "@/lib/guardrails/artifact-guardrails";
import { heartbeatScript } from "@/lib/guardrails/sandbox-guard";
import type { ArtifactLanguage, ArtifactType } from "@/lib/schemas";

import { compileReact } from "./compile";

/**
 * Turns artifact content into what the canvas shows in Preview mode. Everything that
 * executes runs inside a sandboxed `srcdoc` iframe (opaque origin, nonce CSP); nothing
 * from an artifact ever runs in the studio's own origin.
 */

export type PreviewPlan =
  /** `token` identifies this frame's heartbeat messages (see sandbox-guard). */
  | { kind: "iframe"; document: string; token: string }
  | { kind: "image"; src: string }
  | { kind: "markdown"; source: string }
  | { kind: "unavailable"; reasons: string[] };

export interface PreviewInput {
  type: ArtifactType;
  language: ArtifactLanguage;
  content: string;
}

export const MERMAID_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";

/**
 * Bare specifiers React artifacts may import (REACT_RUNNER_MODULES), pinned on jsDelivr.
 * jsDelivr's +esm builds import React by the same pinned URL, so every module shares one
 * React instance.
 */
export const REACT_IMPORT_MAP: Readonly<Record<string, string>> = {
  react: "https://cdn.jsdelivr.net/npm/react@19.3.1/+esm",
  "react/jsx-runtime": "https://cdn.jsdelivr.net/npm/react@19.3.1/jsx-runtime/+esm",
  "react-dom": "https://cdn.jsdelivr.net/npm/react-dom@19.3.1/+esm",
  "react-dom/client": "https://cdn.jsdelivr.net/npm/react-dom@19.3.1/client/+esm",
  "lucide-react": "https://cdn.jsdelivr.net/npm/lucide-react@1.63.0/+esm",
  recharts: "https://cdn.jsdelivr.net/npm/recharts@3.10.1/+esm",
  clsx: "https://cdn.jsdelivr.net/npm/clsx@2.1.1/+esm",
};

/** JSON safe to inline in a <script> element: no "</script" or "<!--" can appear. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const BASE_STYLE =
  "<style>html,body{margin:0;min-height:100%;font:14px/1.5 system-ui,sans-serif}" +
  "#root,#diagram{padding:16px}.runner-error{color:#b91c1c;white-space:pre-wrap;font-family:ui-monospace,monospace}</style>";

function shell(csp: string, body: string[]): string {
  return [
    "<!DOCTYPE html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    BASE_STYLE,
    ...body,
  ].join("\n");
}

/** Runs `source` through Mermaid (strict security level) inside the sandbox. */
export function buildMermaidDocument(source: string, nonce: string): string {
  const csp = buildRunnerCsp(nonce, RUNNER_SCRIPT_HOSTS);
  return shell(csp, [
    '<div id="diagram"></div>',
    `<script type="application/json" id="diagram-source">${inlineJson(source)}</script>`,
    `<script type="module" nonce="${nonce}">`,
    `import mermaid from ${JSON.stringify(MERMAID_MODULE_URL)};`,
    `mermaid.initialize(${inlineJson({ ...MERMAID_RUNNER_CONFIG, theme: "neutral" })});`,
    'const target = document.getElementById("diagram");',
    "try {",
    '  const source = JSON.parse(document.getElementById("diagram-source").textContent);',
    '  const { svg } = await mermaid.render("artifact-diagram", source);',
    "  target.innerHTML = svg;",
    "} catch (error) {",
    '  target.className = "runner-error";',
    '  target.textContent = "Diagram failed to render: " + (error && error.message || error);',
    "}",
    "</script>",
  ]);
}

/**
 * Mounts a compiled React component (an ES module with a default export). The module is
 * imported from a blob: URL created inside the sandbox, so no eval is needed.
 */
export function buildReactDocument(compiled: string, nonce: string): string {
  const csp = buildRunnerCsp(nonce, RUNNER_SCRIPT_HOSTS, { allowBlobScripts: true });
  return shell(csp, [
    `<script type="importmap" nonce="${nonce}">${inlineJson({ imports: REACT_IMPORT_MAP })}</script>`,
    '<div id="root"></div>',
    `<script type="application/json" id="artifact-module">${inlineJson(compiled)}</script>`,
    `<script type="module" nonce="${nonce}">`,
    'const root = document.getElementById("root");',
    "try {",
    '  const code = JSON.parse(document.getElementById("artifact-module").textContent);',
    '  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));',
    "  const [{ createElement }, { createRoot }, artifact] = await Promise.all([",
    '    import("react"), import("react-dom/client"), import(url),',
    "  ]);",
    "  createRoot(root).render(createElement(artifact.default));",
    "} catch (error) {",
    '  root.className = "runner-error";',
    '  root.textContent = "Component failed to load: " + (error && error.message || error);',
    "}",
    "</script>",
  ]);
}

function svgDataUri(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * Put the watchdog bootstrap right after the document head metadata, before any artifact
 * code, so it reports errors from everything that follows.
 */
export function withHeartbeat(document: string, nonce: string, token: string): string {
  const script = `<script nonce="${nonce}">${heartbeatScript(token)}</script>`;
  const at = document.indexOf(VIEWPORT_META);
  if (at === -1) return `${script}\n${document}`;
  const end = at + VIEWPORT_META.length;
  return `${document.slice(0, end)}\n${script}${document.slice(end)}`;
}

/** Decide how to preview an artifact. Never throws: failures become `unavailable`. */
export async function buildPreview(
  input: PreviewInput,
  nonce: string = generateNonce(),
  token: string = generateNonce(),
): Promise<PreviewPlan> {
  // Fail closed: nothing that failed inspection reaches the runner, whatever its state.
  const inspection = await inspectArtifact(input);
  if (!inspection.passed) {
    const reasons = inspection.defects
      .filter(isBlocking)
      .map((defect) => `Line ${defect.line}:${defect.column} - ${defect.message}`);
    return { kind: "unavailable", reasons };
  }

  const prepared = preprocessArtifact(input, { nonce });
  if (prepared.blockers.length > 0) return { kind: "unavailable", reasons: prepared.blockers };
  const iframe = (document: string): PreviewPlan => ({
    kind: "iframe",
    document: withHeartbeat(document, nonce, token),
    token,
  });

  switch (prepared.kind) {
    case "html":
      return iframe(prepared.document);
    case "svg":
      return { kind: "image", src: svgDataUri(prepared.markup) };
    case "mermaid":
      return iframe(buildMermaidDocument(prepared.source, nonce));
    case "react":
      // Inspection already compiled this source successfully.
      return iframe(buildReactDocument(await compileReact(prepared.source, input.language), nonce));
    case "markdown":
      return { kind: "markdown", source: prepared.source };
    case "code":
      return { kind: "unavailable", reasons: ["Source code has no preview; use the Code view."] };
  }
}
