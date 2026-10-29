// Documentation as a tested artifact: every link, anchor, path, command, snippet, asset and
// quoted number in README.md and docs/ must match the repository, so the docs cannot drift.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { MERMAID_DIAGRAM_TYPES } from "@/lib/core/sandbox-preprocessor";
import { clientSchema, serverSchema } from "@/lib/env";
import { MAX_REPAIR_ATTEMPTS } from "@/lib/guardrails/critic-loop";
import { LIMITS } from "@/lib/schemas";

// Not `new URL("..", import.meta.url)`: Vite rewrites that pattern into an asset URL.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const exists = (file: string) => existsSync(path.join(ROOT, file));

const DOCS = [
  "README.md",
  ...readdirSync(path.join(ROOT, "docs"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`),
];
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const major = (name: string) => /(\d+)\./.exec(deps[name] ?? "")?.[1];

interface CodeBlock {
  lang: string;
  code: string;
}

/** Split a Markdown document into fenced code blocks and the prose around them. */
function splitMarkdown(markdown: string): { prose: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  const prose = markdown.replace(/^```([\w-]*)\n([\s\S]*?)^```$/gm, (_match, lang, code) => {
    blocks.push({ lang: String(lang), code: String(code) });
    return "";
  });
  return { prose, blocks };
}

/** GitHub's heading anchor algorithm (lowercase, drop punctuation, spaces to hyphens). */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const { prose } = splitMarkdown(read(file));
  return new Set([...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? "")));
}

/** Link and image targets: Markdown `[..](..)` / `![..](..)` and HTML src/href, outside code. */
function linksOf(file: string): string[] {
  const prose = splitMarkdown(read(file)).prose.replace(/`[^`\n]*`/g, "");
  return [
    ...[...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
    ...[...prose.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ""),
    ...[...prose.matchAll(/<(https?:\/\/[^>]+)>/g)].map((m) => m[1] ?? ""),
  ];
}

/** Inline code spans (outside fenced blocks). */
function inlineCode(file: string): string[] {
  return [...splitMarkdown(read(file)).prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
}

describe.each(DOCS)("%s", (file) => {
  const dir = path.posix.dirname(file);

  it("has working relative links, images and anchors", () => {
    for (const target of linksOf(file)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rawPath = "", fragment] = target.split("#");
      const resolved = rawPath === "" ? file : path.posix.normalize(path.posix.join(dir, rawPath));
      expect(exists(resolved), `${file} → ${target}`).toBe(true);
      if (fragment !== undefined && resolved.endsWith(".md")) {
        expect(anchorsOf(resolved), `${file} → ${target}`).toContain(fragment);
      }
    }
  });

  it("links only to well-formed https URLs", () => {
    for (const target of linksOf(file).filter((t) => /^[a-z]+:/.test(t))) {
      // Plain http only for the local development server.
      expect(target, `${file} → ${target}`).toMatch(/^(https:\/\/|http:\/\/localhost[:/])/);
      expect(() => new URL(target)).not.toThrow();
    }
  });

  it("names repository paths that exist", () => {
    const roots = /^(src|tests|scripts|docs|public|\.github|\.githooks)\//;
    for (const span of inlineCode(file)) {
      const candidate = span.replace(/\/$/, "");
      if (!roots.test(candidate) || /[*\s<>…]/.test(candidate)) continue;
      expect(exists(candidate), `${file}: \`${span}\``).toBe(true);
    }
  });

  it("only runs package scripts that exist, and scripts that are executable", () => {
    // Commands live in inline code and bash blocks; prose ("the pnpm store") is not a command.
    const { blocks } = splitMarkdown(read(file));
    const text = [
      ...inlineCode(file),
      ...blocks.filter((b) => b.lang === "bash").map((b) => b.code),
    ].join("\n");
    const builtins = new Set(["install", "add", "exec", "dlx"]);
    for (const [, script = ""] of text.matchAll(/\bpnpm ([a-z][\w:-]*)/g)) {
      expect(builtins.has(script) || script in pkg.scripts, `${file}: pnpm ${script}`).toBe(true);
    }
    for (const [command = ""] of text.matchAll(/\bscripts\/[\w-]+\.sh\b/g)) {
      expect(statSync(path.join(ROOT, command)).mode & 0o111, command).not.toBe(0);
    }
  });

  it("has snippets that parse", () => {
    for (const { lang, code } of splitMarkdown(read(file)).blocks) {
      if (lang === "mermaid") {
        const keyword = /^\s*([A-Za-z-]+)/.exec(code)?.[1] ?? "";
        expect(MERMAID_DIAGRAM_TYPES.has(keyword), `${file}: mermaid ${keyword}`).toBe(true);
      }
      if (lang === "json") expect(() => JSON.parse(code)).not.toThrow();
      if (lang === "yaml") expect(() => parseYaml(code)).not.toThrow();
      expect(["bash", "mermaid", "text", "json", "yaml"], `${file}: \`\`\`${lang}`).toContain(lang);
    }
  });
});

describe("README", () => {
  const readme = read("README.md");
  const head = readme.slice(0, readme.indexOf("## Contents"));

  it("leads with the interface captures and the architecture diagram", () => {
    for (const asset of [
      "docs/assets/studio-preview.png",
      "docs/assets/studio-live-preview.png",
      "docs/assets/architecture-split-pane.svg",
    ]) {
      expect(head).toContain(`src="${asset}"`);
    }
    // Every image has alt text.
    for (const tag of head.match(/<img [^>]+>/g) ?? []) expect(tag).toMatch(/alt="[^"]{20,}"/);
  });

  it("quotes the stack versions the repository actually uses", () => {
    const badges = [...head.matchAll(/!\[([^\]]+)\]\(https:\/\/img\.shields\.io\/[^)]+\)/g)].map(
      (m) => m[1],
    );
    for (const [badge, dependency] of [
      ["Next.js", "next"],
      ["React", "react"],
      ["Tailwind CSS", "tailwindcss"],
      ["AI SDK", "ai"],
      ["Vitest", "vitest"],
      ["Biome", "@biomejs/biome"],
    ] as const) {
      const quoted = badges.find((b) => b?.startsWith(badge));
      expect(quoted, badge).toBe(`${badge} ${major(dependency)}`);
    }
    expect(readme).toContain(`Node.js ${read(".nvmrc").trim().split(".")[0]} LTS`);
  });

  it("documents exactly the environment variables the app validates", () => {
    const documented = [
      ...readme.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*(server|client|tooling)\s*\|/gm),
    ].map((m) => m[1]);
    const validated = [...Object.keys(serverSchema), ...Object.keys(clientSchema)].filter(
      (key) => key !== "NODE_ENV",
    );
    expect(documented.sort()).toEqual([...validated, "SKIP_ENV_VALIDATION"].sort());
  });

  it("states the coverage threshold the test config enforces", () => {
    const config = read("vitest.config.mts");
    expect(config).toMatch(/branches: 90,/);
    expect(readme).toContain("≥ 90 %");
  });
});

describe("documented numbers match the code", () => {
  // Compare on collapsed whitespace: prose wraps at arbitrary points.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const architecture = flat(read("docs/architecture.md"));

  it.each([
    [`${LIMITS.artifactContentChars.toLocaleString("en-US")} characters per artifact`],
    [`${LIMITS.deltaChars.toLocaleString("en-US")} per delta`],
    [`${LIMITS.frameBytes / 1_048_576} MiB per SSE frame`],
    [`${LIMITS.canvasTabs} canvas tabs`],
    [`${LIMITS.artifactHistory} revisions of history`],
    [`${LIMITS.reorderWindow} out-of-order deltas`],
    [`${LIMITS.consecutiveParseErrors} consecutive malformed frames`],
  ])("architecture.md: %s", (phrase) => {
    expect(architecture).toContain(phrase);
  });

  it("repair budget and container identity", () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(2);
    expect(architecture).toContain("**at most twice per chain**");
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("--uid 1001");
    expect(flat(read("README.md"))).toContain("`nextjs:nodejs` (1001:1001)");
  });

  it("services and options named in operations.md exist", () => {
    const operations = read("docs/operations.md");
    const compose = parseYaml(read("docker-compose.yml"), { merge: true }) as {
      services: Record<string, { profiles?: string[] }>;
    };
    for (const service of ["studio", "studio-offline", "mock-agent"])
      expect(operations).toContain(`\`${service}\``);
    expect(compose.services["studio-offline"]?.profiles).toEqual(["offline"]);
    const smoke = read("scripts/docker-smoke.sh");
    for (const option of ["SMOKE_SKIP_BUILD", "SMOKE_PORT"]) {
      expect(operations).toContain(option);
      expect(smoke).toContain(option);
    }
  });
});

describe("docs/assets", () => {
  const assets = readdirSync(path.join(ROOT, "docs/assets")).sort();

  it("contains exactly the referenced showcase assets", () => {
    expect(assets).toEqual([
      "architecture-split-pane.svg",
      "studio-live-preview.png",
      "studio-preview.png",
    ]);
    const referenced = DOCS.map(read).join("\n");
    for (const asset of assets) expect(referenced).toContain(`assets/${asset}`);
  });

  it.each(["studio-preview.png", "studio-live-preview.png"])(
    "%s is a high-resolution PNG of reasonable size",
    (file) => {
      const bytes = readFileSync(path.join(ROOT, "docs/assets", file));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(width).toBeGreaterThanOrEqual(2560);
      expect(width / height).toBeCloseTo(16 / 10, 1);
      expect(bytes.byteLength).toBeLessThan(1_000_000);
    },
  );

  it("architecture-split-pane.svg is well-formed, accessible and inert", () => {
    const svg = read("docs/assets/architecture-split-pane.svg");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const root = doc.documentElement;
    expect(root.getAttribute("role")).toBe("img");
    expect(doc.querySelector("title")?.textContent).toBeTruthy();
    expect(doc.querySelector("desc")?.textContent?.length).toBeGreaterThan(100);
    // Rendered by GitHub and browsers as an image: no scripts, handlers or external references.
    expect(doc.querySelector("script, foreignObject")).toBeNull();
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^on/i);
        if (/href$/i.test(attribute.name)) expect(attribute.value).toMatch(/^#/);
      }
    }
    expect(svg).not.toMatch(/url\((?!#)/);
  });
});
