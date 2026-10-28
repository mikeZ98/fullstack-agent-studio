import type { ArtifactLanguage, ArtifactPayload, ArtifactType } from "@/lib/schemas";

import {
  parseAttributes,
  type SanitizeResult,
  type SanitizerFinding,
  sanitizeMarkup,
} from "./markup-sanitizer";

/** HTTPS hosts runner documents may load scripts from. */
export const RUNNER_SCRIPT_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
] as const;
export const RUNNER_STYLE_HOSTS = ["fonts.googleapis.com"] as const;
export const RUNNER_FONT_HOSTS = ["fonts.gstatic.com"] as const;

/**
 * `sandbox` attribute for the runner iframe: scripts run, but in an opaque origin with no
 * access to the studio's cookies, storage or DOM, and no top-level navigation or popups.
 */
export const RUNNER_IFRAME_SANDBOX = "allow-scripts";

/** Modules a React artifact may import; everything else blocks the run. */
export const REACT_RUNNER_MODULES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "lucide-react",
  "recharts",
  "clsx",
] as const;

/** Mermaid must be initialised with these; `strict` escapes labels and disables click JS. */
export const MERMAID_RUNNER_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
} as const;

export const MERMAID_DIAGRAM_TYPES = new Set([
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "mindmap",
  "timeline",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "kanban",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
]);

export type PreprocessRule =
  | SanitizerFinding["rule"]
  | "directive"
  | "interaction"
  | "dynamic-code";

export interface PreprocessFinding {
  rule: PreprocessRule;
  detail: string;
}

interface PreprocessedBase {
  findings: PreprocessFinding[];
  /** Reasons the runner must refuse this artifact; empty when it may run. */
  blockers: string[];
}

export interface BlockedImport {
  specifier: string;
  reason: string;
}

export type PreprocessedArtifact =
  | (PreprocessedBase & {
      kind: "html";
      /** Complete document with the CSP meta tag; load via `srcdoc` into a sandboxed frame. */
      document: string;
      csp: string;
      nonce: string;
      externalScripts: string[];
    })
  | (PreprocessedBase & {
      kind: "svg";
      markup: string;
      viewBox: string | null;
      width: string | null;
      height: string | null;
      title: string | null;
    })
  | (PreprocessedBase & {
      kind: "react";
      source: string;
      /** Allowed bare module specifiers, sorted and unique. */
      dependencies: string[];
      blockedImports: BlockedImport[];
      hasDefaultExport: boolean;
    })
  | (PreprocessedBase & { kind: "mermaid"; source: string; diagramType: string | null })
  | (PreprocessedBase & { kind: "markdown"; source: string })
  | (PreprocessedBase & { kind: "code"; source: string; language: ArtifactLanguage });

export interface PreprocessOptions {
  /** CSP nonce; random by default. Inject a fixed one for deterministic output. */
  nonce?: string;
  scriptHosts?: readonly string[];
}

const NONCE_RE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** 128-bit random nonce, base64url. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Content-Security-Policy for runner documents: deny by default; scripts only with the
 * per-render nonce (which also forbids inline handlers, javascript: URLs and eval) or from
 * allowlisted CDNs; no network access, frames, forms, plugins or <base> rewriting.
 */
export function buildRunnerCsp(
  nonce: string,
  scriptHosts: readonly string[] = RUNNER_SCRIPT_HOSTS,
): string {
  if (!NONCE_RE.test(nonce)) throw new Error("CSP nonce must be at least 16 base64 characters");
  const https = (hosts: readonly string[]) => hosts.map((host) => `https://${host}`);
  return [
    "default-src 'none'",
    ["script-src", `'nonce-${nonce}'`, ...https(scriptHosts)].join(" "),
    ["style-src", "'unsafe-inline'", ...https(RUNNER_STYLE_HOSTS)].join(" "),
    ["font-src", "data:", ...https(RUNNER_FONT_HOSTS)].join(" "),
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function blockersFromSanitizer(result: SanitizeResult): string[] {
  return result.droppedFindings > 0
    ? [`${result.droppedFindings} further findings were not recorded`]
    : [];
}

function preprocessHtml(content: string, options: PreprocessOptions): PreprocessedArtifact {
  const nonce = options.nonce ?? generateNonce();
  const scriptHosts = options.scriptHosts ?? RUNNER_SCRIPT_HOSTS;
  const csp = buildRunnerCsp(nonce, scriptHosts);
  const result = sanitizeMarkup(content, {
    mode: "html",
    nonce,
    scriptHosts,
    styleHosts: RUNNER_STYLE_HOSTS,
  });
  // The CSP meta must come first: the parser opens <head> for it, and any <html>/<head>
  // tags in the content merely merge into the elements that already exist.
  const document = [
    "<!DOCTYPE html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    result.markup,
  ].join("\n");
  return {
    kind: "html",
    document,
    csp,
    nonce,
    externalScripts: result.externalScripts,
    findings: result.findings,
    blockers: blockersFromSanitizer(result),
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function preprocessSvg(content: string): PreprocessedArtifact {
  const result = sanitizeMarkup(content, { mode: "svg" });
  const blockers = blockersFromSanitizer(result);
  let markup = result.markup;
  const root = /<svg\b([^>]*)>/i.exec(markup);
  if (root === null) blockers.push("SVG artifacts must contain an <svg> root element");

  const attributes = parseAttributes(root?.[1] ?? "");
  const attr = (name: string) =>
    attributes.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  if (root !== null && attr("xmlns") === null) {
    // Required for the markup to render as a standalone image (data: or blob: URL).
    const at = root.index + "<svg".length;
    markup = `${markup.slice(0, at)} xmlns="${SVG_NS}"${markup.slice(at)}`;
  }
  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(markup)?.[1]?.trim() || null;

  return {
    kind: "svg",
    markup,
    viewBox: attr("viewBox"),
    width: attr("width"),
    height: attr("height"),
    title,
    findings: result.findings,
    blockers,
  };
}

/** Remove comments so commented-out imports and calls are not mistaken for live code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const IMPORT_PATTERNS = [
  /^\s*import\s+(?!type\b)(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/gm,
  /^\s*export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

function importBlockReason(specifier: string): string {
  if (/^\.{0,2}\//.test(specifier)) return "Relative imports are not available in the runner";
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return "URL and protocol imports are not allowed";
  return "Module is not on the runner allowlist";
}

function preprocessReact(content: string): PreprocessedArtifact {
  const code = stripComments(content);
  const specifiers = new Set(
    IMPORT_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[1] ?? "")),
  );
  const allowed: ReadonlySet<string> = new Set(REACT_RUNNER_MODULES);
  const dependencies = [...specifiers].filter((s) => allowed.has(s)).sort();
  const blockedImports = [...specifiers]
    .filter((s) => !allowed.has(s))
    .map((specifier) => ({ specifier, reason: importBlockReason(specifier) }));

  const findings: PreprocessFinding[] = [];
  const blockers = blockedImports.map(({ specifier, reason }) => `${reason}: "${specifier}"`);

  if (/\bimport\s*\(\s*(?!["'\s])/.test(code)) {
    blockers.push("Dynamic import() requires a string literal specifier");
  }
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    blockers.push(`CommonJS require() is not supported: "${m[1]}"`);
  }
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) {
    findings.push({
      rule: "dynamic-code",
      detail: "eval/new Function is blocked by the runner CSP",
    });
  }
  const hasDefaultExport =
    /\bexport\s+default\b/.test(code) || /\bexport\s*\{[^}]*\bas\s+default\b/.test(code);
  if (!hasDefaultExport) blockers.push("React artifacts must default-export a component");

  return {
    kind: "react",
    source: content,
    dependencies,
    blockedImports,
    hasDefaultExport,
    findings,
    blockers,
  };
}

function preprocessMermaid(content: string): PreprocessedArtifact {
  const findings: PreprocessFinding[] = [];
  let source = content.replace(/^\uFEFF/, "");

  // Front matter and %%{init}%% directives can override securityLevel or enable HTML labels.
  const frontMatter = /^\s*---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(source);
  if (frontMatter !== null) {
    source = source.slice(frontMatter[0].length);
    findings.push({ rule: "directive", detail: "front matter config removed" });
  }
  source = source.replace(/%%\{[\s\S]*?\}%%/g, (directive) => {
    findings.push({ rule: "directive", detail: directive.slice(0, 64) });
    return "";
  });
  // `click` binds JS callbacks or links to nodes; drop them entirely.
  source = source
    .split(/\r?\n/)
    .filter((line) => {
      const isClick = /^\s*click\s/i.test(line);
      if (isClick) findings.push({ rule: "interaction", detail: line.trim().slice(0, 64) });
      return !isClick;
    })
    .join("\n");

  const header = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("%%"));
  const keyword = header === undefined ? null : (/^[\w-]+/.exec(header)?.[0] ?? null);
  const diagramType = keyword !== null && MERMAID_DIAGRAM_TYPES.has(keyword) ? keyword : null;
  const blockers =
    diagramType === null ? [`Unsupported or missing Mermaid diagram type: "${keyword ?? ""}"`] : [];

  return { kind: "mermaid", source, diagramType, findings, blockers };
}

export type PreprocessInput = Pick<ArtifactPayload, "type" | "language" | "content">;

const PREPROCESSORS: Record<
  ArtifactType,
  (input: PreprocessInput, options: PreprocessOptions) => PreprocessedArtifact
> = {
  html: ({ content }, options) => preprocessHtml(content, options),
  svg: ({ content }) => preprocessSvg(content),
  react: ({ content }) => preprocessReact(content),
  mermaid: ({ content }) => preprocessMermaid(content),
  // Markdown is rendered without raw HTML by the canvas; nothing to transform here.
  markdown: ({ content }) => ({ kind: "markdown", source: content, findings: [], blockers: [] }),
  code: ({ content, language }) => ({
    kind: "code",
    source: content,
    language,
    findings: [],
    blockers: [],
  }),
};

/**
 * Turn raw artifact content into what the sandbox runner consumes: sanitized markup with a
 * CSP, or source plus extracted requirements, and the reasons (if any) it must not run.
 * Pure apart from the default random nonce.
 */
export function preprocessArtifact(
  input: PreprocessInput,
  options: PreprocessOptions = {},
): PreprocessedArtifact {
  return PREPROCESSORS[input.type](input, options);
}
