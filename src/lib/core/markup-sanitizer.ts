import { LIMITS } from "@/lib/schemas";

/**
 * Allowlist-oriented HTML/SVG scrubber for untrusted artifact markup.
 *
 * Output is re-serialized from what was parsed: every kept tag is rebuilt from its parsed
 * attributes and any "<" that does not open a well-formed tag is escaped. The browser can
 * therefore never read the output differently from how it was checked. This is defence in
 * depth; the primary boundary is the sandboxed, CSP-restricted runner frame
 * (see sandbox-preprocessor.ts), whose nonce-based script-src also blocks any inline
 * handler or javascript: URL that might slip through.
 */

export type SanitizerRule =
  | "forbidden-element"
  | "forbidden-attribute"
  | "event-handler"
  | "unsafe-url"
  | "unsafe-style"
  | "external-script"
  | "external-stylesheet"
  | "malformed-markup";

export interface SanitizerFinding {
  rule: SanitizerRule;
  detail: string;
}

export interface SanitizeOptions {
  mode: "html" | "svg";
  /** HTML mode: nonce stamped on every kept <script>. */
  nonce?: string;
  /** HTTPS hosts allowed for <script src>. */
  scriptHosts?: readonly string[];
  /** HTTPS hosts allowed for <link rel="stylesheet">. */
  styleHosts?: readonly string[];
}

export interface SanitizeResult {
  markup: string;
  findings: SanitizerFinding[];
  /** Findings beyond LIMITS.sanitizerFindings that were counted but not recorded. */
  droppedFindings: number;
  /** Allowed external script URLs, in document order. */
  externalScripts: string[];
}

interface Attribute {
  name: string;
  value: string | undefined;
}

const TAG_RE =
  /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const END_TAG_RE = /<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/y;

/** Elements removed (tag only; their children are still sanitized as markup). */
const DROPPED_ELEMENTS = new Set([
  "base",
  "object",
  "embed",
  "applet",
  "iframe",
  "frame",
  "frameset",
  "portal",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "template",
  "meta",
]);

/** SVG elements removed together with their whole subtree. */
const SVG_DROPPED_SUBTREES = new Set(["script", "foreignobject"]);
const SVG_ANIMATION_ELEMENTS = new Set(["animate", "set", "animatemotion", "animatetransform"]);

const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "data",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "codebase",
]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const FORBIDDEN_ATTRIBUTES = new Set(["nonce", "srcdoc", "http-equiv"]);
const LINK_ELEMENTS = new Set(["a", "area", "form", "button", "input"]);

const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const RESOURCE_SCHEMES = new Set(["http", "https", "blob"]);
const DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml)[;,]/i;
const UNSAFE_STYLE_RE = /expression\(|javascript:|vbscript:|behaviou?r:|-moz-binding/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: "\u00a0",
  sol: "/",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
  semi: ";",
  excl: "!",
  num: "#",
  percnt: "%",
  equals: "=",
  quest: "?",
  plus: "+",
};

/** Decode character references the way a browser would before using an attribute value. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Browsers ignore whitespace and control characters inside a URL scheme. */
function compactUrl(value: string): string {
  return decodeEntities(value).replace(/[\p{Cc}\s]/gu, "");
}

export type UrlContext = "link" | "resource";

export function isSafeUrl(value: string, context: UrlContext): boolean {
  const url = compactUrl(value);
  // An entity we could not decode might hide a scheme separator: refuse it. Only the part
  // before any path, query or fragment can form a scheme, so `?a=1&b=2` stays allowed.
  const head = url.split(/[/?#]/, 1)[0] ?? "";
  if (/&[a-z0-9#]/i.test(head)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return true; // relative, fragment or protocol-relative
  if (context === "link") return LINK_SCHEMES.has(scheme);
  return RESOURCE_SCHEMES.has(scheme) || (scheme === "data" && DATA_IMAGE_RE.test(url));
}

export function isAllowedHostUrl(value: string, hosts: readonly string[]): boolean {
  const url = compactUrl(value);
  if (!URL.canParse(url)) return false;
  const { protocol, hostname, username, password } = new URL(url);
  return protocol === "https:" && username === "" && password === "" && hosts.includes(hostname);
}

export function parseAttributes(source: string): Attribute[] {
  return [...source.matchAll(ATTR_RE)].map((m) => ({
    name: m[1] ?? "",
    value: m[2] ?? m[3] ?? m[4],
  }));
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeTag(name: string, attributes: Attribute[], selfClosing: boolean): string {
  const attrs = attributes
    .map(({ name: attr, value }) =>
      value === undefined ? ` ${attr}` : ` ${attr}="${escapeAttribute(value)}"`,
    )
    .join("");
  return `<${name}${attrs}${selfClosing ? " /" : ""}>`;
}

/** Index just past the end tag closing a raw-text element (script/style), or input end. */
function rawTextEnd(input: string, from: number, name: string): { body: number; after: number } {
  const close = new RegExp(`</${name}(?=[\\s/>])`, "gi");
  close.lastIndex = from;
  const match = close.exec(input);
  if (match === null) return { body: input.length, after: input.length };
  const gt = input.indexOf(">", match.index);
  return { body: match.index, after: gt === -1 ? input.length : gt + 1 };
}

/** Index just past the matching end tag of `name`, honouring nesting. */
function subtreeEnd(input: string, from: number, name: string): number {
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  tags.lastIndex = from;
  let depth = 1;
  for (let m = tags.exec(input); m !== null; m = tags.exec(input)) {
    if (m[1] === "/") depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return tags.lastIndex;
  }
  return input.length;
}

export function sanitizeMarkup(input: string, options: SanitizeOptions): SanitizeResult {
  const { mode, nonce, scriptHosts = [], styleHosts = [] } = options;
  const out: string[] = [];
  const findings: SanitizerFinding[] = [];
  const externalScripts: string[] = [];
  let droppedFindings = 0;

  const report = (rule: SanitizerRule, detail: string) => {
    if (findings.length < LIMITS.sanitizerFindings) findings.push({ rule, detail });
    else droppedFindings++;
  };

  function filterAttributes(tag: string, attributes: Attribute[]): Attribute[] {
    return attributes.filter(({ name, value }) => {
      const attr = name.toLowerCase();
      if (attr.startsWith("on")) {
        report("event-handler", `<${tag} ${attr}>`);
        return false;
      }
      if (FORBIDDEN_ATTRIBUTES.has(attr)) {
        report("forbidden-attribute", `<${tag} ${attr}>`);
        return false;
      }
      if (value === undefined) return true;
      if (attr === "style" && UNSAFE_STYLE_RE.test(compactUrl(value))) {
        report("unsafe-style", `<${tag} style>`);
        return false;
      }
      if (URL_ATTRIBUTES.has(attr)) {
        const context = LINK_ELEMENTS.has(tag) && attr !== "src" ? "link" : "resource";
        if (!isSafeUrl(value, context)) {
          report("unsafe-url", `<${tag} ${attr}>`);
          return false;
        }
      }
      if (SRCSET_ATTRIBUTES.has(attr)) {
        const urls = value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "");
        if (!urls.every((url) => isSafeUrl(url, "resource"))) {
          report("unsafe-url", `<${tag} ${attr}>`);
          return false;
        }
      }
      return true;
    });
  }

  /** Handle the tag at `start`; returns the index to continue scanning from. */
  function openTag(start: number, match: RegExpExecArray): number {
    const [whole, rawName = "", rawAttrs = "", slash = ""] = match;
    const tag = rawName.toLowerCase();
    const selfClosing = slash === "/";
    let next = start + whole.length;
    const attributes = parseAttributes(rawAttrs);

    if (mode === "svg" && SVG_DROPPED_SUBTREES.has(tag)) {
      report("forbidden-element", `<${tag}>`);
      if (selfClosing) return next;
      return tag === "script" ? rawTextEnd(input, next, tag).after : subtreeEnd(input, next, tag);
    }
    if (DROPPED_ELEMENTS.has(tag)) {
      report("forbidden-element", `<${tag}>`);
      return next;
    }
    if (mode === "svg" && SVG_ANIMATION_ELEMENTS.has(tag)) {
      const target = attributes.find((a) => a.name.toLowerCase() === "attributename");
      if (target?.value !== undefined && /^(xlink:)?href$/i.test(target.value.trim())) {
        report("forbidden-element", `<${tag} attributeName="${target.value}">`);
        return next;
      }
    }
    if (tag === "link") {
      const rel = attributes.find((a) => a.name.toLowerCase() === "rel")?.value?.toLowerCase();
      const href = attributes.find((a) => a.name.toLowerCase() === "href")?.value ?? "";
      if (rel?.trim() !== "stylesheet" || !isAllowedHostUrl(href, styleHosts)) {
        report("external-stylesheet", `<link rel="${rel ?? ""}" href="${href}">`);
        return next;
      }
    }

    if (tag === "script") {
      const src = attributes.find((a) => a.name.toLowerCase() === "src")?.value;
      const end = rawTextEnd(input, next, tag);
      if (src !== undefined && !isAllowedHostUrl(src, scriptHosts)) {
        report("external-script", src);
        return end.after;
      }
      if (src !== undefined) externalScripts.push(compactUrl(src));
      const kept = filterAttributes(tag, attributes);
      const stamped = nonce === undefined ? kept : [...kept, { name: "nonce", value: nonce }];
      out.push(serializeTag(rawName, stamped, false), input.slice(next, end.body), "</script>");
      return end.after;
    }

    const kept = filterAttributes(tag, attributes);
    // HTML ignores a self-closing slash; only SVG (foreign content) honours it.
    const closed = selfClosing && mode === "svg";
    out.push(serializeTag(rawName, kept, closed));
    if (tag === "style" && !closed) {
      const end = rawTextEnd(input, next, tag);
      out.push(input.slice(next, end.body), "</style>");
      next = end.after;
    }
    return next;
  }

  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(input.slice(i));
      break;
    }
    out.push(input.slice(i, lt));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 2);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (/^<!doctype[\s>]/i.test(input.slice(lt, lt + 10)) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    END_TAG_RE.lastIndex = lt;
    const end = END_TAG_RE.exec(input);
    if (end !== null) {
      const tag = (end[1] ?? "").toLowerCase();
      const dropped = DROPPED_ELEMENTS.has(tag) || tag === "link" || tag === "script";
      if (!dropped) out.push(`</${end[1]}>`);
      i = lt + end[0].length;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const open = TAG_RE.exec(input);
    if (open !== null) {
      i = openTag(lt, open);
      continue;
    }

    // Not a well-formed tag: emit it as text so no parser can treat it as markup.
    // A bare "<" in prose ("a < b") is routine; only tag-like debris is reported.
    if (/^<[a-zA-Z!/?]/.test(input.slice(lt, lt + 2))) {
      report("malformed-markup", input.slice(lt, lt + 24));
    }
    out.push("&lt;");
    i = lt + 1;
  }

  return { markup: out.join(""), findings, droppedFindings, externalScripts };
}
