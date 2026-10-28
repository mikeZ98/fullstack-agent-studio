import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodeView, HIGHLIGHT_LIMIT, prismLanguage } from "./code-view";
import { Markdown } from "./markdown";

const pre = (container: HTMLElement) => container.querySelector("pre") as HTMLPreElement;

describe("CodeView", () => {
  it("highlights known languages with line numbers", () => {
    const { container } = render(<CodeView code={"const a = b;\nconst c = d;"} language="tsx" />);
    expect(pre(container)).toHaveAttribute("data-highlighted", "true");
    expect(pre(container).className).toContain("language-tsx");
    expect(container.querySelectorAll(".token").length).toBeGreaterThan(0);
    expect(screen.getByText("2")).toHaveAttribute("aria-hidden");
  });

  it("can hide line numbers", () => {
    const { container } = render(<CodeView code="x" language="py" lineNumbers={false} />);
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });

  it("falls back to plain text for unknown languages", () => {
    expect(prismLanguage("mermaid")).toBe("plain");
    expect(prismLanguage("py")).toBe("py");
    const { container } = render(<CodeView code="graph TD" language="mermaid" />);
    expect(pre(container).className).toContain("language-plain");
  });

  it("skips highlighting above the size limit", () => {
    const code = "x".repeat(HIGHLIGHT_LIMIT + 1);
    const { container } = render(<CodeView code={code} language="html" />);
    expect(pre(container)).toHaveAttribute("data-highlighted", "false");
    expect(pre(container).textContent).toHaveLength(code.length);
  });

  it("uses a dark theme when the system prefers it", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("dark"),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    const dark = pre(render(<CodeView code="let x = 1" language="js" />).container);
    vi.unstubAllGlobals();
    const light = pre(render(<CodeView code="let x = 1" language="js" />).container);

    expect(dark.style.color).not.toBe("");
    expect(dark.style.color).not.toBe(light.style.color);
    expect(dark.style.backgroundColor).toBe("transparent");
  });
});

describe("Markdown", () => {
  it("renders GitHub-flavoured markdown", () => {
    render(<Markdown source={"| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~"} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("highlights fenced code with and without a language", () => {
    const { container } = render(
      <Markdown source={"```\nplain\nblock\n```\n\n```tsx\nconst a = 1\n```"} />,
    );
    const blocks = container.querySelectorAll("pre[data-highlighted]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.className).toContain("language-plain");
    expect(blocks[1]?.className).toContain("language-tsx");
  });

  it("keeps inline code inline", () => {
    render(<Markdown source="Use `npm i` now" />);
    expect(screen.getByText("npm i").tagName).toBe("CODE");
  });

  it("opens links in a new, isolated tab", () => {
    render(<Markdown source="[docs](https://example.com/docs)" />);
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
  });
});
