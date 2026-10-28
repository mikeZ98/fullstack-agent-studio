import { describe, expect, it } from "vitest";

import { MOCK_ARTIFACTS } from "@/lib/tools/mock-agent-provider";

import { artifactFileName, artifactMimeType } from "./files";
import {
  buildMermaidDocument,
  buildPreview,
  buildReactDocument,
  compileReact,
  inlineJson,
  MERMAID_MODULE_URL,
  REACT_IMPORT_MAP,
} from "./preview";

const NONCE = "test-nonce-0123456789";

function scriptBodies(document: string): string[] {
  return [...document.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(
    (m) => `${m[1]}|${m[2]}`,
  );
}

describe("inlineJson", () => {
  it("cannot close the surrounding script element", () => {
    const json = inlineJson("</script><script>alert(1)</script><!--");
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toBe("</script><script>alert(1)</script><!--");
  });
});

describe("buildMermaidDocument", () => {
  it("renders the source with Mermaid's strict config inside a nonce CSP", () => {
    const document = buildMermaidDocument("graph TD\n  A-->B</script>", NONCE);
    expect(document.startsWith("<!DOCTYPE html>\n<meta charset")).toBe(true);
    expect(document).toContain(`script-src 'nonce-${NONCE}'`);
    const scriptSrc = /script-src [^;]*/.exec(document)?.[0] ?? "";
    expect(scriptSrc).not.toContain("blob:");
    expect(document).toContain(`import mermaid from "${MERMAID_MODULE_URL}"`);
    expect(document).toContain('"securityLevel":"strict"');
    expect(document.match(/<\/script>/g)).toHaveLength(2);
    const executable = scriptBodies(document).filter((s) => s.includes("nonce="));
    expect(executable).toHaveLength(1);
  });
});

describe("buildReactDocument", () => {
  it("maps the allowed modules and imports the component from a blob", () => {
    const document = buildReactDocument('export default function A(){return "</script>"}', NONCE);
    expect(document).toContain(`script-src 'nonce-${NONCE}' blob: https://cdnjs.cloudflare.com`);
    const importMap = /<script type="importmap" nonce="[^"]+">([^<]*)<\/script>/.exec(
      document,
    )?.[1];
    expect(JSON.parse(importMap ?? "{}")).toEqual({ imports: REACT_IMPORT_MAP });
    expect(document).toContain("URL.createObjectURL(new Blob([code]");
    expect(document.match(/<\/script>/g)).toHaveLength(3);
  });

  it("pins every module to jsDelivr with a single React version", () => {
    const urls = Object.values(REACT_IMPORT_MAP);
    expect(urls.every((url) => url.startsWith("https://cdn.jsdelivr.net/npm/"))).toBe(true);
    const reactVersions = new Set(
      urls.flatMap((url) => /\/react(?:-dom)?@([\d.]+)/.exec(url)?.[1] ?? []),
    );
    expect(reactVersions.size).toBe(1);
  });
});

describe("compileReact", () => {
  it("strips types and compiles JSX to the automatic runtime, keeping ESM imports", async () => {
    const code = await compileReact(MOCK_ARTIFACTS.react.content, "tsx");
    expect(code).toContain('from "react"');
    expect(code).toContain("react/jsx-runtime");
    expect(code).toContain("export default function TodoList");
    expect(code).not.toContain("useState<string[]>");
    expect(code).not.toMatch(/<li\b/);
  });

  it("compiles plain JSX", async () => {
    expect(await compileReact("export default () => <b>x</b>;", "jsx")).toContain("jsx");
  });
});

describe("buildPreview", () => {
  it.each([
    ["html", "html"],
    ["mermaid", "mermaid"],
    ["react", "tsx"],
  ] as const)("runs %s artifacts in a sandboxed document", async (type, language) => {
    const plan = await buildPreview(
      { type, language, content: MOCK_ARTIFACTS[type].content },
      NONCE,
    );
    expect(plan.kind).toBe("iframe");
    if (plan.kind === "iframe") expect(plan.document).toContain(`'nonce-${NONCE}'`);
  });

  it("renders SVG as a data URI image of the sanitized markup", async () => {
    const plan = await buildPreview({
      type: "svg",
      language: "svg",
      content: "<svg onload='x()'><circle/></svg>",
    });
    expect(plan.kind).toBe("image");
    if (plan.kind === "image") {
      const markup = decodeURIComponent(plan.src.replace("data:image/svg+xml;charset=utf-8,", ""));
      expect(markup).not.toContain("onload");
      expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
  });

  it("hands markdown to the in-app renderer", async () => {
    expect(await buildPreview({ type: "markdown", language: "md", content: "# T" })).toEqual({
      kind: "markdown",
      source: "# T",
    });
  });

  it.each([
    [{ type: "code", language: "py", content: "x" }, "Source code has no preview"],
    [
      {
        type: "react",
        language: "tsx",
        content: 'import x from "lodash";\nexport default () => null;',
      },
      "allowlist",
    ],
    [
      { type: "react", language: "tsx", content: "export default () => <div" },
      "Component does not compile",
    ],
    [{ type: "svg", language: "svg", content: "<p>no root</p>" }, "<svg> root"],
  ] as const)("reports why %j cannot be previewed", async (input, reason) => {
    const plan = await buildPreview(input);
    expect(plan.kind).toBe("unavailable");
    if (plan.kind === "unavailable") expect(plan.reasons.join(" ")).toContain(reason);
  });
});

describe("artifact files", () => {
  it.each([
    ["Pricing Table", "html", "pricing-table.html"],
    ["Café Menü!", "tsx", "cafe-menu.tsx"],
    ["  ", "md", "artifact.md"],
    ["Flow", "mermaid", "flow.mmd"],
    ["Script", "rust", "script.rust"],
    ["Odd", "c++", "odd.txt"],
    ["x".repeat(100), "py", `${"x".repeat(64)}.py`],
  ])("names %j (%s) as %s", (title, language, expected) => {
    expect(artifactFileName(title, language)).toBe(expected);
  });

  it("maps types to MIME types", () => {
    expect(artifactMimeType("svg")).toBe("image/svg+xml;charset=utf-8");
    expect(artifactMimeType("react")).toBe("text/plain;charset=utf-8");
  });
});
