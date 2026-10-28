import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ArtifactRecord,
  type ArtifactStoreAction,
  artifactReducer,
  contentHash,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
} from "@/lib/core/artifact-reducer";
import type { CanvasAction } from "@/lib/core/canvas-reducer";
import { CircuitBreaker, RUNNER_CHANNEL } from "@/lib/guardrails/sandbox-guard";
import { renderWithStudio, sealedArtifact, studioValue } from "~tests/fixtures/studio";

import { ArtifactPreview } from "./artifact-preview";
import { ArtifactViewer, resolveDisplayed } from "./artifact-viewer";
import { CanvasPanel } from "./canvas-panel";
import { CanvasToolbar, COPIED_FEEDBACK_MS, downloadArtifact } from "./canvas-toolbar";
import { EmptyCanvas } from "./empty-canvas";
import { TabStrip } from "./tab-strip";

function recordOf(actions: ArtifactStoreAction[], id = "a1"): ArtifactRecord {
  const record = selectArtifact(actions.reduce(artifactReducer, INITIAL_ARTIFACT_STORE), id);
  if (record === undefined) throw new Error("missing record");
  return record;
}

const open = (
  artifactId: string,
  artifactType: "html" | "code" | "react" = "html",
): CanvasAction => ({
  type: "open-tab",
  artifactId,
  artifactType,
});

/** Two sealed revisions of a1: v1 html, v2 react. */
const twoRevisions = [
  ...sealedArtifact("a1", "<p>v1</p>", { title: "Page" }),
  ...sealedArtifact("a1", "export default () => null", {
    type: "react",
    title: "Page v2",
    revision: 2,
  }),
];

describe("TabStrip", () => {
  function setup(activeArtifactId = "a2") {
    const records = new Map<string, ArtifactRecord>([
      ["a1", recordOf(sealedArtifact("a1", "x", { title: "First" }))],
      ["a2", recordOf(sealedArtifact("a2", "x", { title: "Second", type: "code" }), "a2")],
      ["a3", recordOf(sealedArtifact("a3", "x", { title: "Third" }).slice(0, 2), "a3")],
    ]);
    const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onPinRevision: vi.fn() };
    render(
      <TabStrip
        tabs={[...records.keys(), "ghost"].map((artifactId) => ({
          artifactId,
          viewMode: "preview" as const,
        }))}
        activeArtifactId={activeArtifactId}
        lookup={(id) => records.get(id)}
        {...handlers}
      />,
    );
    return handlers;
  }

  it("marks the active tab and the streaming one", () => {
    setup();
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: /Third/ })).toContainElement(
      screen.getByLabelText("Generating"),
    );
    expect(screen.getByRole("tab", { name: "ghost" })).toBeInTheDocument();
  });

  it("selects and closes with the mouse", async () => {
    const { onSelect, onClose } = setup();
    await userEvent.click(screen.getByRole("tab", { name: "First" }));
    expect(onSelect).toHaveBeenCalledWith("a1");
    await userEvent.click(screen.getByRole("button", { name: "Close Second" }));
    expect(onClose).toHaveBeenCalledWith("a2");
  });

  it("navigates with the keyboard, wrapping, and closes with Delete", async () => {
    const { onSelect, onClose } = setup();
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Second" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("a3");
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("a2");
    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("ghost");
    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("a1");
    await user.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledWith("a1");
    onSelect.mockClear();
    await user.keyboard("x");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("wraps left from the first tab", async () => {
    const { onSelect } = setup("a1");
    screen.getByRole("tab", { name: "First" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("ghost");
  });

  it("offers a revision picker once an artifact has history", async () => {
    const onPinRevision = vi.fn();
    const record = recordOf(twoRevisions);
    const { rerender } = render(
      <TabStrip
        tabs={[{ artifactId: "a1", viewMode: "code" }]}
        activeArtifactId="a1"
        lookup={() => record}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onPinRevision={onPinRevision}
      />,
    );
    const picker = screen.getByRole("combobox", { name: "Revision" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Latest (v2)", "v2", "v1"]);
    await userEvent.selectOptions(picker, "1");
    expect(onPinRevision).toHaveBeenLastCalledWith("a1", 1);

    rerender(
      <TabStrip
        tabs={[{ artifactId: "a1", viewMode: "code", pinnedRevision: 1 }]}
        activeArtifactId="a1"
        lookup={() => record}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onPinRevision={onPinRevision}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Revision" })).toHaveValue("1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Revision" }), "latest");
    expect(onPinRevision).toHaveBeenLastCalledWith("a1", null);
  });
});

describe("resolveDisplayed", () => {
  const record = recordOf(twoRevisions);

  it("shows the live revision by default", () => {
    expect(resolveDisplayed(record)).toMatchObject({
      revision: 2,
      type: "react",
      pinned: false,
      streaming: false,
    });
  });

  it("shows a pinned older snapshot", () => {
    expect(resolveDisplayed(record, 1)).toMatchObject({
      revision: 1,
      type: "html",
      content: "<p>v1</p>",
      pinned: true,
    });
  });

  it("treats pinning the latest or an evicted revision as live", () => {
    expect(resolveDisplayed(record, 2).pinned).toBe(false);
    expect(resolveDisplayed(record, 9).pinned).toBe(false);
  });
});

describe("ArtifactViewer", () => {
  it("shows live code while streaming, even in Preview mode", () => {
    const record = recordOf(sealedArtifact("a1", "<h1>partial").slice(0, 2));
    render(
      <ArtifactViewer record={record} displayed={resolveDisplayed(record)} viewMode="preview" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "the preview appears when the artifact is complete",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("<h1>partial");
    expect(screen.queryByTitle(/preview/)).not.toBeInTheDocument();
  });

  it("shows the error and the partial source for a failed artifact", () => {
    const record = recordOf([
      ...sealedArtifact("a1", "<p>").slice(0, 2),
      { type: "stream-aborted" },
    ]);
    render(
      <ArtifactViewer record={record} displayed={resolveDisplayed(record)} viewMode="preview" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Stream interrupted.");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("<p>");
  });

  it("previews a sealed artifact", async () => {
    const record = recordOf(sealedArtifact("a1", "<p>Hi</p>", { title: "Hello" }));
    render(
      <ArtifactViewer record={record} displayed={resolveDisplayed(record)} viewMode="preview" />,
    );
    expect(await screen.findByTitle("Hello preview")).toHaveAttribute("sandbox", "allow-scripts");
  });
});

describe("ArtifactPreview", () => {
  it("shows a placeholder while the preview is prepared", () => {
    render(<ArtifactPreview type="html" language="html" content="<p/>" title="T" />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing preview");
  });

  it("renders markdown in-app", async () => {
    render(
      <ArtifactPreview type="markdown" language="md" content={"# Notes\n\n- one"} title="Notes" />,
    );
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeInTheDocument();
  });

  it("renders SVG as an image", async () => {
    render(
      <ArtifactPreview
        type="svg"
        language="svg"
        content="<svg viewBox='0 0 1 1'><script>x</script></svg>"
        title="Icon"
      />,
    );
    const image = await screen.findByRole("img", { name: "Icon" });
    expect(decodeURIComponent(image.getAttribute("src") ?? "")).not.toContain("<script");
  });

  it("explains why a preview is unavailable", async () => {
    render(<ArtifactPreview type="mermaid" language="mermaid" content="not a diagram" title="D" />);
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(/A Mermaid diagram must start with a supported type/),
    ).toBeInTheDocument();
  });

  it("ignores a stale preview when the content changes quickly", async () => {
    const { rerender } = render(
      <ArtifactPreview type="markdown" language="md" content="# One" title="T" />,
    );
    rerender(<ArtifactPreview type="markdown" language="md" content="# Two" title="T" />);
    expect(await screen.findByRole("heading", { name: "Two" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "One" })).not.toBeInTheDocument();
  });
});

describe("CanvasToolbar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const displayed = resolveDisplayed(
    recordOf(sealedArtifact("a1", "<p>copy me</p>", { title: "My Page" })),
  );

  function setup(overrides: Partial<Parameters<typeof CanvasToolbar>[0]> = {}) {
    const props = { onViewModeChange: vi.fn(), onHide: vi.fn() };
    render(
      <CanvasToolbar
        displayed={displayed}
        state="complete"
        viewMode="preview"
        {...props}
        {...overrides}
      />,
    );
    return props;
  }

  it("switches view modes and hides the canvas", async () => {
    const { onViewModeChange, onHide } = setup();
    await userEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(onViewModeChange).toHaveBeenCalledWith("code");
    await userEvent.click(screen.getByRole("button", { name: "Hide canvas" }));
    expect(onHide).toHaveBeenCalled();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("disables Preview for source code", () => {
    setup({ displayed: { ...displayed, type: "code" }, viewMode: "code" });
    expect(screen.getByRole("tab", { name: "Preview" })).toBeDisabled();
  });

  it("copies the source and confirms briefly", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Copy source" }));
    expect(await navigator.clipboard.readText()).toBe("<p>copy me</p>");
    const copied = screen.getByRole("button", { name: "Copied" });
    await waitFor(() => expect(copied).toHaveAccessibleName("Copy source"), {
      timeout: COPIED_FEEDBACK_MS + 1000,
    });
  });

  it("stays quiet when the clipboard is unavailable", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Copy source" }));
    expect(writeText).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy source" })).toBeInTheDocument();
  });

  it("downloads the source under a safe file name", async () => {
    const createObjectURL = vi.fn(() => "blob:artifact");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe("my-page.html");
      expect(this.href).toBe("blob:artifact");
    });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalledOnce();
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("text/html;charset=utf-8");
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact"));
  });

  it("labels pinned revisions and disables actions that make no sense", () => {
    setup({ displayed: { ...displayed, pinned: true, revision: 1 } });
    expect(screen.getByText("v1 (pinned)")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("disables Download while streaming and Copy when empty", () => {
    setup({ displayed: { ...displayed, streaming: true, content: "" } });
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy source" })).toBeDisabled();
  });

  it("exports downloadArtifact for reuse", () => {
    expect(typeof downloadArtifact).toBe("function");
  });
});

describe("EmptyCanvas", () => {
  it("offers to reopen recent artifacts, newest first", async () => {
    const value = studioValue({
      artifactActions: [
        ...sealedArtifact("a1", "x", { title: "Old" }),
        ...sealedArtifact("a2", "y", { title: "New", type: "code" }),
      ],
    });
    renderWithStudio(<EmptyCanvas />, value);
    const list = screen.getByRole("list", { name: "Recent artifacts" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["New", "Old"]);
    await userEvent.click(within(list).getByRole("button", { name: "Old" }));
    expect(value.activateArtifact).toHaveBeenCalledWith("a1");
  });

  it("has nothing to reopen at first", () => {
    renderWithStudio(<EmptyCanvas />);
    expect(screen.getByRole("heading", { name: "No artifact open" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("CanvasPanel", () => {
  it("shows the empty state without tabs", () => {
    renderWithStudio(<CanvasPanel />);
    expect(screen.queryByRole("tablist", { name: "Open artifacts" })).not.toBeInTheDocument();
    expect(screen.getByText("No artifact open")).toBeInTheDocument();
  });

  it("wires tab, view-mode, pin and hide actions to the canvas reducer", async () => {
    const value = studioValue({
      artifactActions: [
        ...twoRevisions,
        ...sealedArtifact("a2", "print()", { type: "code", title: "Script" }),
      ],
      canvasActions: [open("a2", "code"), open("a1", "react")],
    });
    renderWithStudio(<CanvasPanel />, value);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Script" }));
    expect(value.dispatchCanvas).toHaveBeenCalledWith({ type: "set-active-tab", artifactId: "a2" });
    await user.click(screen.getByRole("button", { name: "Close Script" }));
    expect(value.dispatchCanvas).toHaveBeenCalledWith({ type: "close-tab", artifactId: "a2" });
    await user.click(screen.getByRole("tab", { name: "Code" }));
    expect(value.dispatchCanvas).toHaveBeenCalledWith({
      type: "set-view-mode",
      artifactId: "a1",
      artifactType: "react",
      viewMode: "code",
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "Revision" }), "1");
    expect(value.dispatchCanvas).toHaveBeenCalledWith({
      type: "pin-revision",
      artifactId: "a1",
      revision: 1,
    });
    await user.click(screen.getByRole("button", { name: "Hide canvas" }));
    expect(value.dispatchCanvas).toHaveBeenCalledWith({ type: "set-open", isOpen: false });
  });

  it("forces Code view for a tab whose artifact cannot be previewed", () => {
    const value = studioValue({
      artifactActions: sealedArtifact("a2", "print(1)", { type: "code", title: "Script" }),
      canvasActions: [open("a2", "code")],
    });
    renderWithStudio(<CanvasPanel />, value);
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("print(1)");
  });

  it("falls back to the empty state if the active artifact is unknown", async () => {
    const value = studioValue({ canvasActions: [open("ghost")] });
    renderWithStudio(<CanvasPanel />, value);
    expect(screen.getByRole("tab", { name: "ghost" })).toBeInTheDocument();
    expect(screen.getByText("No artifact open")).toBeInTheDocument();
    await act(async () => undefined);
  });
});

describe("ArtifactPreview — sandbox watchdog", () => {
  const HTML = "<p>Hello</p>";

  async function mount(breaker = new CircuitBreaker(2)) {
    render(
      <ArtifactPreview
        type="html"
        language="html"
        content={HTML}
        title="Watched"
        bootTimeoutMs={80}
        stallTimeoutMs={80}
        breaker={breaker}
      />,
    );
    const frame = (await screen.findByTitle("Watched preview")) as HTMLIFrameElement;
    const token = /"token":"([^"]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1] ?? "";
    const post = (
      data: Record<string, unknown>,
      source: MessageEventSource | null = frame.contentWindow,
    ) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { channel: RUNNER_CHANNEL, token, ...data },
            source,
          }),
        );
      });
    return { frame, token, post, breaker };
  }

  it("keeps a heartbeating preview running and relays its runtime errors", async () => {
    const { token, post } = await mount();
    expect(token).not.toBe("");
    for (let i = 0; i < 4; i++) {
      post({ type: "heartbeat" });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    }
    expect(screen.getByTitle("Watched preview")).toBeInTheDocument();
    post({ type: "error", message: "TypeError: x is undefined" });
    expect(screen.getByRole("alert", { name: "Runtime errors" })).toHaveTextContent(
      "TypeError: x is undefined",
    );
  });

  it("ignores messages from other windows", async () => {
    const { post } = await mount();
    post({ type: "error", message: "spoofed" }, window);
    expect(screen.queryByRole("alert", { name: "Runtime errors" })).not.toBeInTheDocument();
  });

  it("shuts a hung preview down, offers a re-run, then opens the circuit", async () => {
    const breaker = new CircuitBreaker(2);
    const { post } = await mount(breaker);
    post({ type: "heartbeat" });
    expect(
      await screen.findByText("The preview stopped responding and was shut down."),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("Watched preview")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(await screen.findByTitle("Watched preview")).toBeInTheDocument();
    expect(await screen.findByText("Preview disabled")).toBeInTheDocument();
    expect(breaker.isOpen(`html:${contentHash(HTML)}`)).toBe(true);
  });

  it("reports a preview that never starts", async () => {
    await mount();
    expect(
      await screen.findByText("The preview did not start in time and was shut down."),
    ).toBeInTheDocument();
  });
});
