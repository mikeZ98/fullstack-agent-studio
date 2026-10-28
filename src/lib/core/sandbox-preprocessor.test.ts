import { describe, expect, it } from "vitest";

import { type ArtifactType, LIMITS } from "@/lib/schemas";

import {
  buildRunnerCsp,
  generateNonce,
  MERMAID_RUNNER_CONFIG,
  type PreprocessedArtifact,
  preprocessArtifact,
  RUNNER_IFRAME_SANDBOX,
} from "./sandbox-preprocessor";

const NONCE = "test-nonce-0123456789";

function prep<K extends PreprocessedArtifact["kind"]>(
  type: ArtifactType & K,
  content: string,
  language = type === "react" ? "tsx" : type,
): Extract<PreprocessedArtifact, { kind: K }> {
  const result = preprocessArtifact({ type, language, content }, { nonce: NONCE });
  if (result.kind !== type) throw new Error(`expected ${type}, got ${result.kind}`);
  return result as Extract<PreprocessedArtifact, { kind: K }>;
}

describe("buildRunnerCsp", () => {
  it("denies by default and allows scripts only by nonce or allowlisted host", () => {
    const csp = buildRunnerCsp(NONCE, ["cdn.jsdelivr.net"]);
    const directives = Object.fromEntries(
      csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]),
    );
    expect(directives).toMatchObject({
      "default-src": "'none'",
      "script-src": `'nonce-${NONCE}' https://cdn.jsdelivr.net`,
      "connect-src": "'none'",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'none'",
      "img-src": "data: blob:",
    });
    expect(csp).not.toMatch(/unsafe-eval|strict-dynamic|\*/);
    expect(directives["script-src"]).not.toContain("unsafe-inline");
  });

  it.each(["", "short", "has space in it 123456", "quote'injection-0123456"])(
    "rejects an unsafe nonce %j",
    (nonce) => {
      expect(() => buildRunnerCsp(nonce)).toThrow(/nonce/);
    },
  );

  it("generates distinct, CSP-safe nonces", () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(() => buildRunnerCsp(nonce)).not.toThrow();
  });

  it("exposes a sandbox without same-origin access", () => {
    expect(RUNNER_IFRAME_SANDBOX).toBe("allow-scripts");
  });
});

describe("preprocessArtifact — html", () => {
  it("wraps sanitized markup in a document whose first element is the CSP", () => {
    const result = prep(
      "html",
      `<!doctype html><html><head><title>T</title></head><body><button onclick="go()">Go</button><script>function go(){}</script></body></html>`,
    );
    const lines = result.document.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "<!DOCTYPE html>",
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${result.csp}">`,
    ]);
    expect(result.document).toContain(`<script nonce="${NONCE}">function go(){}</script>`);
    expect(result.document).not.toContain("onclick");
    expect(result.document.match(/<!doctype/gi)).toHaveLength(1);
    expect(result.findings.map((f) => f.rule)).toEqual(["event-handler"]);
    expect(result.blockers).toEqual([]);
    expect(result.nonce).toBe(NONCE);
  });

  it("lists allowlisted CDN scripts and removes others", () => {
    const result = prep(
      "html",
      `<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script><script src="https://evil.example/x.js"></script>`,
    );
    expect(result.externalScripts).toEqual([
      "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    ]);
    expect(result.document).not.toContain("evil.example");
  });

  it("uses a fresh random nonce by default", () => {
    const a = preprocessArtifact({ type: "html", language: "html", content: "<script>x</script>" });
    const b = preprocessArtifact({ type: "html", language: "html", content: "<script>x</script>" });
    if (a.kind !== "html" || b.kind !== "html") throw new Error("expected html");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.document).toContain(`nonce="${a.nonce}"`);
    expect(a.csp).toContain(`'nonce-${a.nonce}'`);
  });

  it("blocks documents that overflow the findings budget", () => {
    const result = prep("html", "<i onclick=x></i>".repeat(LIMITS.sanitizerFindings + 1));
    expect(result.blockers).toEqual(["1 further findings were not recorded"]);
  });
});

describe("preprocessArtifact — svg", () => {
  it("extracts root metadata and scrubs active content", () => {
    const result = prep(
      "svg",
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="20"><title> Logo </title><script>alert(1)</script><circle r="4"/></svg>`,
    );
    expect(result).toMatchObject({
      viewBox: "0 0 10 10",
      width: "10",
      height: "20",
      title: "Logo",
      blockers: [],
    });
    expect(result.markup).not.toContain("script");
    expect(result.markup.match(/xmlns=/g)).toHaveLength(1);
  });

  it("adds the SVG namespace when missing", () => {
    const result = prep("svg", `<svg viewBox="0 0 1 1"><rect/></svg>`);
    expect(result.markup).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect /></svg>`,
    );
    expect(result).toMatchObject({ width: null, height: null, title: null });
  });

  it("refuses content without an <svg> root", () => {
    const result = prep("svg", "<div>not svg</div>");
    expect(result.blockers).toEqual(["SVG artifacts must contain an <svg> root element"]);
    expect(result.viewBox).toBeNull();
  });
});

describe("preprocessArtifact — react", () => {
  const component = (imports: string) =>
    `${imports}\nexport default function App() { return <div />; }`;

  it("collects allowed dependencies, sorted and de-duplicated", () => {
    const result = prep(
      "react",
      component(`import { useState } from "react";
import {
  BarChart,
  Bar,
} from 'recharts';
import * as Icons from "lucide-react";
import React, { useEffect } from "react";
import type { FC } from "some-types-only-package";
import "clsx";`),
    );
    expect(result.dependencies).toEqual(["clsx", "lucide-react", "react", "recharts"]);
    expect(result.blockedImports).toEqual([]);
    expect(result).toMatchObject({ hasDefaultExport: true, blockers: [], findings: [] });
    expect(result.source).toContain("export default function App");
  });

  it("blocks relative, remote and unlisted modules with reasons", () => {
    const result = prep(
      "react",
      component(`import a from "./local";
import b from "../up";
import c from "https://esm.sh/lodash";
import fs from "node:fs";
import _ from "lodash";
export { x } from "./reexport";
const lazy = import("left-pad");`),
    );
    expect(result.blockedImports).toEqual([
      { specifier: "./local", reason: "Relative imports are not available in the runner" },
      { specifier: "../up", reason: "Relative imports are not available in the runner" },
      { specifier: "https://esm.sh/lodash", reason: "URL and protocol imports are not allowed" },
      { specifier: "node:fs", reason: "URL and protocol imports are not allowed" },
      { specifier: "lodash", reason: "Module is not on the runner allowlist" },
      { specifier: "./reexport", reason: "Relative imports are not available in the runner" },
      { specifier: "left-pad", reason: "Module is not on the runner allowlist" },
    ]);
    expect(result.blockers).toHaveLength(7);
  });

  it("ignores imports inside comments", () => {
    const result = prep(
      "react",
      component(`// import bad from "lodash";
/* import worse from "./x"; */
import { useState } from "react"; // trailing comment with https://example.com`),
    );
    expect(result.blockedImports).toEqual([]);
    expect(result.dependencies).toEqual(["react"]);
  });

  it("blocks non-literal dynamic imports and require()", () => {
    const result = prep("react", component(`const m = import(name);\nconst x = require("react");`));
    expect(result.blockers).toEqual([
      "Dynamic import() requires a string literal specifier",
      'CommonJS require() is not supported: "react"',
    ]);
  });

  it("flags eval and new Function", () => {
    const result = prep("react", component("const f = new Function('return 1'); eval('2');"));
    expect(result.findings).toEqual([
      { rule: "dynamic-code", detail: "eval/new Function is blocked by the runner CSP" },
    ]);
  });

  it.each([
    ["export default function App() {}", true],
    ["const App = () => null;\nexport default App;", true],
    ["function App() {}\nexport { App as default };", true],
    ["export function App() {}", false],
    ["// export default App", false],
  ])("detects a default export in %j", (source, expected) => {
    const result = prep("react", source);
    expect(result.hasDefaultExport).toBe(expected);
    expect(result.blockers.includes("React artifacts must default-export a component")).toBe(
      !expected,
    );
  });
});

describe("preprocessArtifact — mermaid", () => {
  it("detects the diagram type", () => {
    const result = prep("mermaid", "%% a comment\n\nflowchart LR\n  A --> B");
    expect(result).toMatchObject({ diagramType: "flowchart", blockers: [], findings: [] });
  });

  it("strips config directives, front matter and click handlers", () => {
    const source = [
      "﻿---",
      "config:",
      "  securityLevel: loose",
      "---",
      '%%{init: {"securityLevel": "loose", "htmlLabels": true}}%%',
      "graph TD",
      "  A --> B",
      '  click A callback "Tooltip"',
      '  CLICK B href "javascript:alert(1)"',
    ].join("\n");
    const result = prep("mermaid", source);
    expect(result.source).not.toMatch(/securityLevel|click|javascript/i);
    expect(result.source).toContain("A --> B");
    expect(result.diagramType).toBe("graph");
    expect(result.findings.map((f) => f.rule)).toEqual([
      "directive",
      "directive",
      "interaction",
      "interaction",
    ]);
  });

  it.each([
    [
      "an unknown diagram type",
      "flowchartz TD",
      'Unsupported or missing Mermaid diagram type: "flowchartz"',
    ],
    ["empty content", "  \n%% only a comment\n", 'Unsupported or missing Mermaid diagram type: ""'],
  ])("blocks %s", (_case, source, blocker) => {
    expect(prep("mermaid", source).blockers).toEqual([blocker]);
  });

  it("documents the strict runner configuration", () => {
    expect(MERMAID_RUNNER_CONFIG).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
    });
  });
});

describe("preprocessArtifact — markdown and code", () => {
  it("passes markdown through for escaping renderers", () => {
    expect(prep("markdown", "# Title\n<b>raw</b>", "md")).toEqual({
      kind: "markdown",
      source: "# Title\n<b>raw</b>",
      findings: [],
      blockers: [],
    });
  });

  it("passes code through with its language", () => {
    expect(prep("code", "print('hi')", "py")).toEqual({
      kind: "code",
      source: "print('hi')",
      language: "py",
      findings: [],
      blockers: [],
    });
  });
});
