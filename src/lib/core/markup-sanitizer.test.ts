import { describe, expect, it } from "vitest";

import { LIMITS } from "@/lib/schemas";

import {
  decodeEntities,
  isAllowedHostUrl,
  isSafeUrl,
  type SanitizeOptions,
  sanitizeMarkup,
} from "./markup-sanitizer";

const HOSTS = { scriptHosts: ["cdn.jsdelivr.net"], styleHosts: ["fonts.googleapis.com"] };
const html = (input: string, options: Partial<SanitizeOptions> = {}) =>
  sanitizeMarkup(input, { mode: "html", nonce: "n0nce-n0nce-n0nce", ...HOSTS, ...options });
const svg = (input: string) => sanitizeMarkup(input, { mode: "svg" });
const rules = (result: { findings: { rule: string }[] }) => result.findings.map((f) => f.rule);

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);

describe("sanitizeMarkup — benign markup", () => {
  it("round-trips well-formed markup with normalized quoting", () => {
    const result = html(`<p class='lead' data-x=1 hidden>Hi <b>there</b> &amp; you</p>`);
    expect(result.markup).toBe('<p class="lead" data-x="1" hidden>Hi <b>there</b> &amp; you</p>');
    expect(result.findings).toEqual([]);
  });

  it("escapes a bare < in prose without reporting it", () => {
    const result = html("<p>1 < 2 and 3 <= 4</p>");
    expect(result.markup).toBe("<p>1 &lt; 2 and 3 &lt;= 4</p>");
    expect(result.findings).toEqual([]);
  });

  it("drops comments, doctypes and processing instructions", () => {
    const result = html("<!DOCTYPE html><?xml version='1.0'?><!-- secret --><p>x</p><!---->");
    expect(result.markup).toBe("<p>x</p>");
  });

  it("drops an unterminated comment and everything after it", () => {
    expect(html("<p>a</p><!-- <script>alert(1)</script>").markup).toBe("<p>a</p>");
  });
});

describe("sanitizeMarkup — event handlers and attributes", () => {
  it.each([
    `<img src="a.png" onerror="alert(1)">`,
    `<img src="a.png" ONERROR='alert(1)'>`,
    `<img src="a.png" onerror=alert(1)>`,
    `<div onmouseover="x" onfocus>`,
    `<svg onload="alert(1)">`,
  ])("strips inline event handlers from %s", (input) => {
    const result = html(input);
    expect(result.markup).not.toMatch(/\son[a-z]+/i);
    expect(rules(result)).toContain("event-handler");
  });

  it("strips nonce, srcdoc and http-equiv attributes", () => {
    const result = html(
      `<div nonce="stolen" srcdoc="<script>x</script>" http-equiv="refresh">x</div>`,
    );
    expect(result.markup).toBe("<div>x</div>");
    expect(rules(result)).toEqual([
      "forbidden-attribute",
      "forbidden-attribute",
      "forbidden-attribute",
    ]);
  });

  it("drops dangerous inline styles", () => {
    const result = html(`<p style="color: red">a</p><p style="width: expression(alert(1))">b</p>`);
    expect(result.markup).toBe('<p style="color: red">a</p><p>b</p>');
    expect(rules(result)).toEqual(["unsafe-style"]);
  });

  it("escapes markup hidden in attribute values (mXSS)", () => {
    const payload = `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>`;
    const result = html(payload);
    expect(result.markup).toBe(
      '<p title="&lt;/noscript&gt;&lt;img src=x onerror=alert(1)&gt;"></p>',
    );
  });
});

describe("sanitizeMarkup — URLs", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    `  javascript:alert(1)`,
    `java${TAB}script:alert(1)`,
    "java&#x09;script:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "&#0000106avascript:alert(1)",
    "javascript&colon;alert(1)",
    "javascript&unknown;:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    `java${NUL}script:alert(1)`,
  ])("removes href=%j", (url) => {
    const result = html(`<a href="${url}">x</a>`);
    expect(result.markup).toBe("<a>x</a>");
    expect(rules(result)).toEqual(["unsafe-url"]);
  });

  it.each([
    "https://example.com/a?b=1&amp;c=2",
    "http://example.com",
    "mailto:a@example.com",
    "tel:+1555",
    "/relative/path",
    "#section",
    "?q=1",
    "//cdn.example.com/x",
  ])("keeps href=%j", (url) => {
    expect(html(`<a href="${url}">x</a>`).findings).toEqual([]);
  });

  it("allows only image data: URLs for resources", () => {
    const ok = html(`<img src="data:image/png;base64,AAAA">`);
    expect(ok.findings).toEqual([]);
    const bad = html(`<img src="data:text/html;base64,AAAA"><a href="data:image/png,x">x</a>`);
    expect(rules(bad)).toEqual(["unsafe-url", "unsafe-url"]);
  });

  it("checks every srcset candidate", () => {
    expect(html(`<img srcset="a.png 1x, b.png 2x">`).findings).toEqual([]);
    expect(rules(html(`<img srcset="a.png 1x, javascript:alert(1) 2x">`))).toEqual(["unsafe-url"]);
  });

  it("checks form actions as navigations", () => {
    expect(
      rules(html(`<form action="javascript:alert(1)"><button formaction="javascript:x">`)),
    ).toEqual(["unsafe-url", "unsafe-url"]);
  });
});

describe("sanitizeMarkup — forbidden elements", () => {
  it.each(["iframe", "object", "embed", "frame", "base", "noscript", "template", "portal"])(
    "removes <%s> tags but keeps their text",
    (tag) => {
      const result = html(`<${tag} src="https://evil.example">fallback</${tag}>`);
      expect(result.markup).toBe("fallback");
      expect(rules(result)).toEqual(["forbidden-element"]);
    },
  );

  it("removes meta refresh redirects", () => {
    const result = html(`<meta http-equiv="refresh" content="0;url=https://evil.example">`);
    expect(result.markup).toBe("");
  });

  it("keeps only allowlisted stylesheets", () => {
    const ok = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`;
    expect(html(ok).markup).toBe(ok);
    for (const bad of [
      `<link rel="stylesheet" href="https://evil.example/x.css">`,
      `<link rel="import" href="https://fonts.googleapis.com/x">`,
      `<link rel="prefetch" href="https://evil.example">`,
      `<link rel="stylesheet">`,
    ]) {
      const result = html(bad);
      expect(result.markup, bad).toBe("");
      expect(rules(result)).toEqual(["external-stylesheet"]);
    }
  });
});

describe("sanitizeMarkup — scripts (HTML)", () => {
  it("stamps the nonce on inline scripts and keeps their source verbatim", () => {
    const result = html(
      `<script>if (a < b && c > d) document.body.innerHTML = "<b>x</b>";</script>`,
    );
    expect(result.markup).toBe(
      `<script nonce="n0nce-n0nce-n0nce">if (a < b && c > d) document.body.innerHTML = "<b>x</b>";</script>`,
    );
  });

  it("replaces a smuggled nonce with the real one", () => {
    const result = html(`<script nonce="guess">x()</script>`);
    expect(result.markup).toBe(`<script nonce="n0nce-n0nce-n0nce">x()</script>`);
  });

  it("keeps allowlisted external scripts and records them", () => {
    const src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    const result = html(`<script src="${src}" defer></script>`);
    expect(result.markup).toBe(`<script src="${src}" defer nonce="n0nce-n0nce-n0nce"></script>`);
    expect(result.externalScripts).toEqual([src]);
  });

  it.each([
    "https://evil.example/x.js",
    "http://cdn.jsdelivr.net/x.js",
    "https://user:pw@cdn.jsdelivr.net/x.js",
    "//cdn.jsdelivr.net/x.js",
    "data:text/javascript,alert(1)",
  ])("removes a script from a disallowed source %j, including its body", (src) => {
    const result = html(`<p>a</p><script src="${src}">fallback()</script><p>b</p>`);
    expect(result.markup).toBe("<p>a</p><p>b</p>");
    expect(rules(result)).toEqual(["external-script"]);
  });

  it("treats a self-closing <script/> as an open raw-text element, like browsers do", () => {
    const result = html(`<script/>alert(1)</script><p>x</p>`);
    expect(result.markup).toBe(`<script nonce="n0nce-n0nce-n0nce">alert(1)</script><p>x</p>`);
  });

  it("closes an unterminated script at end of input", () => {
    expect(html("<script>never closed").markup).toBe(
      `<script nonce="n0nce-n0nce-n0nce">never closed</script>`,
    );
  });

  it("keeps style element contents verbatim", () => {
    const css = "<style>a > b { content: '<i>'; }</style>";
    expect(html(css).markup).toBe(css);
  });

  it("omits the nonce when none is configured", () => {
    expect(sanitizeMarkup("<script>x()</script>", { mode: "html" }).markup).toBe(
      "<script>x()</script>",
    );
  });

  it("drops stray end tags of removed elements", () => {
    expect(html("a</script></iframe></link></p>").markup).toBe("a</p>");
  });
});

describe("sanitizeMarkup — malformed markup", () => {
  it.each([
    [`<img src=x onerror=alert(1)//`, "&lt;img src=x onerror=alert(1)//"],
    [`<img/src=x/onerror=alert(1)>`, "&lt;img/src=x/onerror=alert(1)>"],
    [`<a href="x"onclick="y">z</a>`, `&lt;a href="x"onclick="y">z</a>`],
    [`</a foo>`, "&lt;/a foo>"],
    [`<![CDATA[<script>]]>`, '&lt;![CDATA[<script nonce="n0nce-n0nce-n0nce">]]></script>'],
  ])("neutralizes %s", (input, expected) => {
    const result = html(input);
    expect(result.markup).toBe(expected);
    expect(rules(result)).toContain("malformed-markup");
  });
});

describe("sanitizeMarkup — SVG", () => {
  it("removes scripts with their contents", () => {
    const result = svg(`<svg><script>alert(1)</script><circle r="1"/><script/></svg>`);
    expect(result.markup).toBe('<svg><circle r="1" /></svg>');
    expect(rules(result)).toEqual(["forbidden-element", "forbidden-element"]);
  });

  it("removes foreignObject subtrees, including nested ones", () => {
    const input = `<svg><foreignObject><foreignObject><b>x</b></foreignObject><i>y</i></foreignObject><rect/></svg>`;
    expect(svg(input).markup).toBe("<svg><rect /></svg>");
    expect(svg(`<svg><foreignObject/><rect/></svg>`).markup).toBe("<svg><rect /></svg>");
    expect(svg(`<svg><foreignObject><b>unclosed`).markup).toBe("<svg>");
  });

  it("removes animations that rewrite links", () => {
    const input = `<svg><a href="#"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName=" xlink:href " values="x"/><animate attributeName="opacity" values="0;1"/></a></svg>`;
    const result = svg(input);
    expect(result.markup).toBe(
      '<svg><a href="#"><animate attributeName="opacity" values="0;1" /></a></svg>',
    );
    expect(rules(result)).toEqual(["forbidden-element", "forbidden-element"]);
  });

  it("checks xlink:href and preserves attribute case", () => {
    const result = svg(
      `<svg viewBox="0 0 1 1"><use xlink:href="javascript:alert(1)"/><use href="#ok"/></svg>`,
    );
    expect(result.markup).toBe('<svg viewBox="0 0 1 1"><use /><use href="#ok" /></svg>');
  });
});

describe("sanitizeMarkup — findings budget", () => {
  it("caps recorded findings and counts the rest", () => {
    const result = html("<b onclick=x></b>".repeat(LIMITS.sanitizerFindings + 25));
    expect(result.findings).toHaveLength(LIMITS.sanitizerFindings);
    expect(result.droppedFindings).toBe(25);
  });
});

describe("URL helpers", () => {
  it("decodes numeric and named references", () => {
    expect(decodeEntities("&#65;&#x42;&colon;&amp;&Tab;&bogus;&#0;&#x110000;")).toBe(
      `AB:&${TAB}&bogus;��`,
    );
  });

  it("validates allowlisted hosts strictly", () => {
    const hosts = ["cdn.jsdelivr.net"];
    expect(isAllowedHostUrl("https://cdn.jsdelivr.net/x.js", hosts)).toBe(true);
    expect(isAllowedHostUrl("https://cdn.jsdelivr.net.evil.example/x.js", hosts)).toBe(false);
    expect(isAllowedHostUrl("not a url", hosts)).toBe(false);
  });

  it("treats unknown schemes as unsafe in both contexts", () => {
    expect(isSafeUrl("chrome://settings", "link")).toBe(false);
    expect(isSafeUrl("blob:https://x/1", "resource")).toBe(true);
    expect(isSafeUrl("blob:https://x/1", "link")).toBe(false);
  });
});
