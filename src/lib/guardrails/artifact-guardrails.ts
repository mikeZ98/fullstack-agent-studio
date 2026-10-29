import {
  MERMAID_DIAGRAM_TYPES,
  RUNNER_FONT_HOSTS,
  RUNNER_SCRIPT_HOSTS,
  RUNNER_STYLE_HOSTS,
} from "@/lib/core/sandbox-preprocessor";
import { compileErrorPosition, compileReact } from "@/lib/runner/compile";
import {
  type ArtifactLanguage,
  type ArtifactType,
  createProblem,
  LIMITS,
  type ProblemDetails,
} from "@/lib/schemas";

import { detectRunawayLoops, maskJs } from "./sandbox-guard";

/**
 * Static inspection of artifact source before it may run. It complements the sandbox
 * (opaque origin + nonce CSP), which stays the actual security boundary: these checks
 * fail closed on code that tries to escape it or would break in it, and explain why
 * precisely enough for the critic loop to ask the agent for a fix.
 */

export type DefectSeverity = "critical" | "high" | "medium" | "low";

export type ArtifactRule =
  | "empty-artifact"
  | "syntax-error"
  | "unbalanced-markup"
  | "missing-svg-root"
  | "script-breakout"
  | "script-escape-state"
  | "frame-escape"
  | "cookie-access"
  | "storage-access"
  | "dynamic-code"
  | "network-sink"
  | "navigation-sink"
  | "embedded-frame"
  | "inline-handler"
  | "javascript-url"
  | "external-resource"
  | "runaway-loop"
  | "unsupported-diagram"
  | "diagram-directive"
  | "raw-html";

export interface ArtifactDefect {
  rule: ArtifactRule;
  severity: DefectSeverity;
  message: string;
  /** 1-based position in the artifact source. */
  line: number;
  column: number;
  /** The offending source line, trimmed. */
  excerpt: string;
}

export interface ArtifactInspection {
  /** False when any critical or high defect was found: the artifact must not run. */
  passed: boolean;
  /** 100 minus severity weights, floored at 0. Same input, same score. */
  score: number;
  defects: ArtifactDefect[];
}

export interface InspectionInput {
  type: ArtifactType;
  language: ArtifactLanguage;
  content: string;
}

export const SEVERITY_WEIGHTS: Readonly<Record<DefectSeverity, number>> = {
  critical: 50,
  high: 25,
  medium: 8,
  low: 2,
};

const SEVERITY_RANK: Readonly<Record<DefectSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function isBlocking(defect: ArtifactDefect): boolean {
  return defect.severity === "critical" || defect.severity === "high";
}

/** 1-based line and column of `index` in `text`. */
export function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, index));
  const line = before.split("\n").length;
  return { line, column: index - before.lastIndexOf("\n") };
}

class DefectLog {
  readonly defects: ArtifactDefect[] = [];

  constructor(private readonly source: string) {}

  add(rule: ArtifactRule, severity: DefectSeverity, index: number, message: string): void {
    const { line, column } = lineColumnAt(this.source, index);
    const excerpt = (this.source.split("\n")[line - 1] ?? "").trim().slice(0, 160);
    this.defects.push({ rule, severity, message, line, column, excerpt });
  }

  addAt(
    rule: ArtifactRule,
    severity: DefectSeverity,
    line: number,
    column: number,
    message: string,
  ): void {
    const excerpt = (this.source.split("\n")[line - 1] ?? "").trim().slice(0, 160);
    this.defects.push({ rule, severity, message, line, column, excerpt });
  }
}

// --- JavaScript rules (React source, inline <script>s and handlers) ----------------------

interface CodeRule {
  rule: ArtifactRule;
  severity: DefectSeverity;
  pattern: RegExp;
  message: string;
}

const CODE_RULES: readonly CodeRule[] = [
  {
    rule: "frame-escape",
    severity: "critical",
    pattern: /\b(?:window|self|globalThis)\s*\.\s*(?:parent|top|opener|frameElement)\b/g,
    message: "Reaching out of the sandbox frame (window.parent/top/opener) is forbidden.",
  },
  {
    rule: "frame-escape",
    severity: "critical",
    pattern:
      /(?<![.\w$])(?:parent|top|opener)\s*\.\s*(?:postMessage|location|document|window|frames|opener)\b/g,
    message: "Reaching out of the sandbox frame (parent/top/opener) is forbidden.",
  },
  {
    rule: "cookie-access",
    severity: "critical",
    pattern: /\bdocument\s*\.\s*(?:cookie|domain)\b/g,
    message: "Reading or writing document.cookie / document.domain is forbidden.",
  },
  {
    rule: "storage-access",
    severity: "high",
    pattern:
      /\b(?:localStorage|sessionStorage)\s*(?:\.|\[)|\b(?:window|self|globalThis)\s*\.\s*(?:localStorage|sessionStorage)\b|\bindexedDB\b|\bcaches\s*\.\s*open\b/g,
    message:
      "Persistent browser storage is unavailable in the sandbox; keep state in memory (e.g. useState).",
  },
  {
    rule: "dynamic-code",
    severity: "critical",
    pattern: /\beval\s*\(|(?<![.\w$])(?:new\s+)?Function\s*\(/g,
    message: "Dynamic code execution (eval / Function) is forbidden.",
  },
  {
    rule: "dynamic-code",
    severity: "high",
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
    message: "Passing a string to setTimeout/setInterval evaluates code; pass a function.",
  },
  {
    rule: "network-sink",
    severity: "high",
    pattern:
      /(?<![.\w$])fetch\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker)\b|\bnavigator\s*\.\s*sendBeacon\b|\bimportScripts\s*\(/g,
    message: "Network requests are blocked in the sandbox; embed the data in the artifact.",
  },
  {
    rule: "navigation-sink",
    severity: "high",
    pattern:
      /\b(?:window|document|self)\s*\.\s*location\s*(?:=[^=]|\.\s*(?:href\s*=[^=]|assign|replace))|(?<![.\w$])location\s*(?:\.\s*(?:href\s*=[^=]|assign\s*\(|replace\s*\()|(?<!(?:\b(?:const|let|var)\s+|[(,]\s*)location\s*)=[^=>])|\bwindow\s*\.\s*open\s*\(/g,
    message: "Navigating away from or opening windows from the sandbox is forbidden.",
  },
];

function scanCode(code: string, offset: number, log: DefectLog): void {
  const masked = maskJs(code, { strings: false });
  for (const { rule, severity, pattern, message } of CODE_RULES) {
    for (const match of masked.matchAll(pattern))
      log.add(rule, severity, offset + match.index, message);
  }
  for (const loop of detectRunawayLoops(code)) {
    log.add(
      "runaway-loop",
      "high",
      offset + loop.index,
      "This loop can never exit and would freeze the preview; add a break condition.",
    );
  }
}

// --- Resource URLs ------------------------------------------------------------------------

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  ...RUNNER_SCRIPT_HOSTS,
  ...RUNNER_STYLE_HOSTS,
  ...RUNNER_FONT_HOSTS,
]);

function isExternalUrl(value: string): boolean {
  const url = value.trim();
  if (!/^(?:https?:)?\/\//i.test(url)) return false;
  try {
    return !ALLOWED_HOSTS.has(new URL(url, "https://base.invalid").hostname);
  } catch {
    return true;
  }
}

const EXTERNAL_MESSAGE =
  "External resources are blocked by the sandbox CSP; inline them (data: URI or SVG).";

// --- HTML / SVG ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Elements whose end tag HTML allows to be omitted. */
const OPTIONAL_END = new Set([
  "html",
  "head",
  "body",
  "p",
  "li",
  "dt",
  "dd",
  "option",
  "optgroup",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
  "caption",
  "rt",
  "rp",
]);

const TAG_RE =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Copy of `html` with comments and raw-text element bodies blanked (offsets preserved). */
function maskMarkup(html: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  // Raw-text bodies first: a "<!--" inside a script is script text, not a comment.
  return html
    .replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(?=<\/\2\s*>|$)/gi,
      (_m, open: string, _tag, body: string) => open + blank(body),
    )
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
}

/** Does a script body end inside an unterminated string (a "</script>" inside a literal)? */
function endsInsideString(code: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (quote !== null) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      else if (char === "\n" && quote !== "`") quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (char === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 1;
    }
  }
  return quote !== null;
}

function inspectScripts(html: string, log: DefectLog): void {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)(<\/script\s*>|$)/gi)) {
    const [whole, attrs = "", body = "", close = ""] = match;
    const bodyStart = match.index + whole.indexOf(">") + 1;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (close !== "" && endsInsideString(body)) {
      log.add(
        "script-breakout",
        "critical",
        bodyStart + body.length,
        'A "</script>" inside a string literal ends the script early; escape it as "<\\/script>".',
      );
    }
    const escapeAt = body.search(/<!--|<script\b/i);
    if (escapeAt !== -1) {
      log.add(
        "script-escape-state",
        "high",
        bodyStart + escapeAt,
        'Avoid "<!--" and "<script" inside inline scripts; they change how the parser finds the end of the script.',
      );
    }
    scanCode(body, bodyStart, log);
  }
}

function inspectMarkup(html: string, mode: "html" | "svg", log: DefectLog): void {
  const masked = maskMarkup(html);
  const stack: { name: string; index: number }[] = [];
  const severity: DefectSeverity = mode === "svg" ? "high" : "medium";

  for (const match of masked.matchAll(TAG_RE)) {
    const [, slash, rawName = "", attrs = "", selfClose] = match;
    const name = rawName.toLowerCase();
    const index = match.index;

    if (slash !== "/") {
      inspectTag(name, attrs, index + 1 + rawName.length, log);
      const isVoid = mode === "html" && VOID_ELEMENTS.has(name);
      const optional = mode === "html" && OPTIONAL_END.has(name);
      if (selfClose !== "/" && !isVoid && !optional) stack.push({ name, index });
      continue;
    }
    if (mode === "html" && (VOID_ELEMENTS.has(name) || OPTIONAL_END.has(name))) continue;
    const at = stack.map((entry) => entry.name).lastIndexOf(name);
    if (at === -1) {
      log.add(
        "unbalanced-markup",
        severity,
        index,
        `Closing tag </${rawName}> has no matching opening tag.`,
      );
      continue;
    }
    for (const unclosed of stack.splice(at).slice(1)) {
      log.add("unbalanced-markup", severity, unclosed.index, `<${unclosed.name}> is never closed.`);
    }
  }
  for (const unclosed of stack) {
    log.add("unbalanced-markup", severity, unclosed.index, `<${unclosed.name}> is never closed.`);
  }

  // On the original source: <style> bodies are blanked in `masked`.
  for (const match of html.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
    if (isExternalUrl(match[1] ?? ""))
      log.add("external-resource", "medium", match.index, EXTERNAL_MESSAGE);
  }
}

const RESOURCE_ATTRS = new Set(["src", "srcset", "poster", "data", "background", "xlink:href"]);

function inspectTag(name: string, attrSource: string, attrOffset: number, log: DefectLog): void {
  if (["iframe", "frame", "frameset", "object", "embed", "portal", "applet"].includes(name)) {
    log.add(
      "embedded-frame",
      "high",
      attrOffset - name.length - 1,
      `<${name}> elements are not allowed in artifacts.`,
    );
  }
  if (name === "base") {
    log.add(
      "navigation-sink",
      "high",
      attrOffset - name.length - 1,
      "<base> rewrites every URL in the document and is not allowed.",
    );
  }

  for (const attr of attrSource.matchAll(ATTR_RE)) {
    const attrName = (attr[1] ?? "").toLowerCase();
    const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
    const at = attrOffset + attr.index;
    if (attrName.startsWith("on")) {
      log.add(
        "inline-handler",
        "medium",
        at,
        "Inline event handlers are blocked by the CSP; attach listeners with addEventListener in a <script>.",
      );
      scanCode(
        value,
        at +
          attr[0].length -
          value.length -
          (attr[2] !== undefined || attr[3] !== undefined ? 1 : 0),
        log,
      );
    }
    if (/^\s*(?:javascript|vbscript):/i.test(value.replace(/[\s\p{Cc}]/gu, ""))) {
      log.add("javascript-url", "high", at, "javascript: URLs are forbidden.");
    }
    if (name === "meta" && attrName === "http-equiv" && /refresh/i.test(value)) {
      log.add(
        "navigation-sink",
        "high",
        at,
        '<meta http-equiv="refresh"> redirects the frame and is not allowed.',
      );
    }
    if (name === "form" && attrName === "action" && isExternalUrl(value)) {
      log.add("network-sink", "high", at, "Forms must not submit to external endpoints.");
    }
    const isResource =
      RESOURCE_ATTRS.has(attrName) ||
      (name === "link" && attrName === "href") ||
      (name === "use" && attrName === "href");
    if (
      isResource &&
      value.split(",").some((candidate) => isExternalUrl(candidate.trim().split(/\s+/)[0] ?? ""))
    ) {
      log.add("external-resource", "medium", at, EXTERNAL_MESSAGE);
    }
  }
}

// --- React / JSX ----------------------------------------------------------------------

/** Characters after which, outside JSX, a `<` starts an element rather than a generic. */
const JSX_START_CONTEXT = /(?:^|[(,=[{}?:&|>;]|\breturn|\bdefault)$/;

/**
 * Match JSX opening and closing tag names. Sucrase validates nesting but accepts
 * `<div></span>`, so names are checked here. Inside an element every `<` is a tag; outside,
 * only where an expression can start, so `useState<Item>(` is not read as a tag.
 */
function inspectJsxTags(source: string, log: DefectLog): void {
  const code = maskJs(source, { strings: true });
  const stack: { name: string; index: number }[] = [];
  const label = (tag: string) => (tag === "" ? "fragment" : `<${tag}>`);

  for (let i = code.indexOf("<"); i !== -1; i = code.indexOf("<", i + 1)) {
    const head = /^<(\/?)([A-Za-z][\w.:-]*)?/.exec(code.slice(i, i + 256));
    const closing = head?.[1] === "/";
    const name = head?.[2] ?? "";
    const after = i + (head?.[0].length ?? 1);
    if (name === "" && code[after] !== ">") continue;
    if (stack.length === 0 && (closing || !JSX_START_CONTEXT.test(code.slice(0, i).trimEnd())))
      continue;

    // Find the tag's closing ">" outside attribute expressions ({() => x} contains ">").
    let depth = 0;
    let end = after;
    for (; end < code.length; end++) {
      const char = code[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth <= 0) break;
    }
    if (end >= code.length) break;
    const start = i;
    const selfClosing = code.slice(start, end).trimEnd().endsWith("/");
    i = end;
    if (selfClosing) continue;
    if (!closing) {
      stack.push({ name, index: start });
      continue;
    }
    const open = stack.pop();
    if (open !== undefined && open.name !== name) {
      const opened = lineColumnAt(source, open.index).line;
      log.add(
        "syntax-error",
        "high",
        start,
        `Closing ${label(name)} does not match ${label(open.name)} opened on line ${opened}.`,
      );
    }
  }
}

function inspectReact(source: string, log: DefectLog): void {
  scanCode(source, 0, log);
  for (const match of maskJs(source, { strings: false }).matchAll(
    /\bsrc\s*=\s*\{?\s*["'`]([^"'`]+)/g,
  )) {
    if (isExternalUrl(match[1] ?? ""))
      log.add("external-resource", "medium", match.index, EXTERNAL_MESSAGE);
  }
  inspectJsxTags(source, log);
}

// --- Mermaid & Markdown -------------------------------------------------------------------

function inspectMermaid(source: string, log: DefectLog): void {
  const frontMatter = /^\s*---\r?\n[\s\S]*?\r?\n---/.exec(source);
  if (frontMatter !== null) {
    log.add(
      "diagram-directive",
      "low",
      frontMatter.index,
      "Front matter configuration is ignored; the runner enforces its own config.",
    );
  }
  for (const match of source.matchAll(/%%\{[\s\S]*?\}%%/g)) {
    const severity = /securityLevel|htmlLabels|loose/i.test(match[0]) ? "medium" : "low";
    log.add(
      "diagram-directive",
      severity,
      match.index,
      "Diagram directives cannot change the runner's security settings and are removed.",
    );
  }
  for (const match of source.matchAll(/^[ \t]*click\b.*$/gim)) {
    log.add(
      "diagram-directive",
      "low",
      match.index,
      "click interactions are disabled in previews and are removed.",
    );
  }

  const body = source
    .slice(frontMatter?.[0].length ?? 0)
    .replace(/%%\{[\s\S]*?\}%%/g, (m) => m.replace(/[^\n]/g, " "));
  const header = /^[ \t]*(?!%%)(\S.*)$/m.exec(body);
  const keyword = header === null ? null : (/^[\w-]+/.exec(header[1] ?? "")?.[0] ?? null);
  if (keyword === null || !MERMAID_DIAGRAM_TYPES.has(keyword)) {
    const index = header === null ? 0 : (frontMatter?.[0].length ?? 0) + header.index;
    const found = keyword === null ? "nothing" : `"${keyword}"`;
    log.add(
      "unsupported-diagram",
      "high",
      index,
      `A Mermaid diagram must start with a supported type (flowchart, sequenceDiagram, ...); found ${found}.`,
    );
  }
}

function inspectMarkdown(source: string, log: DefectLog): void {
  for (const match of source.matchAll(/<script\b|javascript:/gi)) {
    log.add(
      "raw-html",
      "low",
      match.index,
      "Raw HTML and javascript: links are not rendered in Markdown previews.",
    );
  }
}

// --- Entry points -------------------------------------------------------------------------

function finish(log: DefectLog): ArtifactInspection {
  const defects = [...log.defects]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.line - b.line ||
        a.column - b.column ||
        a.rule.localeCompare(b.rule),
    )
    .slice(0, LIMITS.artifactDefects);
  const penalty = log.defects.reduce((sum, defect) => sum + SEVERITY_WEIGHTS[defect.severity], 0);
  return { passed: !defects.some(isBlocking), score: Math.max(0, 100 - penalty), defects };
}

/** Every check that needs no compiler. Synchronous and deterministic. */
export function inspectArtifactSource(input: InspectionInput): ArtifactInspection {
  const { type, content } = input;
  const log = new DefectLog(content);
  if (content.trim() === "") {
    log.add("empty-artifact", "high", 0, "The artifact is empty.");
    return finish(log);
  }
  switch (type) {
    case "html":
      inspectScripts(content, log);
      inspectMarkup(content, "html", log);
      break;
    case "svg":
      if (!/<svg\b/i.test(content))
        log.add(
          "missing-svg-root",
          "high",
          0,
          "An SVG artifact must contain an <svg> root element.",
        );
      inspectScripts(content, log);
      inspectMarkup(content, "svg", log);
      break;
    case "react":
      inspectReact(content, log);
      break;
    case "mermaid":
      inspectMermaid(content, log);
      break;
    case "markdown":
      inspectMarkdown(content, log);
      break;
    case "code":
      // Plain source is displayed, never executed.
      break;
  }
  return finish(log);
}

/** Full inspection: the static checks plus, for React, a real compile. */
export async function inspectArtifact(input: InspectionInput): Promise<ArtifactInspection> {
  const result = inspectArtifactSource(input);
  if (input.type !== "react" || input.content.trim() === "") return result;
  try {
    await compileReact(input.content, input.language);
    return result;
  } catch (error) {
    const log = new DefectLog(input.content);
    log.defects.push(...result.defects);
    const position = compileErrorPosition(error) ?? { line: 1, column: 1 };
    const message = error instanceof Error ? error.message : String(error);
    log.addAt(
      "syntax-error",
      "high",
      position.line,
      position.column,
      `The component does not compile: ${message}`,
    );
    return finish(log);
  }
}

/** RFC 9457 envelope for an artifact that failed inspection. */
export function inspectionToProblem(inspection: ArtifactInspection): ProblemDetails {
  const blocking = inspection.defects.filter(isBlocking);
  const first = blocking[0] ?? inspection.defects[0];
  const count = blocking.length;
  return createProblem("artifact_rejected", {
    detail:
      first === undefined
        ? "The artifact failed inspection."
        : `${count} blocking issue${count === 1 ? "" : "s"}; first at line ${first.line}: ${first.message}`,
    errors: inspection.defects.slice(0, LIMITS.problemErrors).map((defect) => ({
      path: `line ${defect.line}:${defect.column}`,
      message: `[${defect.severity}] ${defect.rule}: ${defect.message}`.slice(
        0,
        LIMITS.issueMessageLength,
      ),
    })),
  });
}
