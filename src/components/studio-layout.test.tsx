import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "~tests/fixtures/studio";

import { Studio } from "./studio";
import {
  readStoredSplitRatio,
  SPLIT_RATIO_STORAGE_KEY,
  useStudio,
  writeStoredSplitRatio,
} from "./studio-provider";

beforeEach(() => {
  localStorage.clear();
});

/** matchMedia stub: `desktop` decides the layout breakpoint; dark mode stays off. */
function stubViewport(desktop: boolean) {
  const listeners = new Set<() => void>();
  let isDesktop = desktop;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query.includes("min-width") ? isDesktop : false;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })),
  );
  return {
    resize(next: boolean) {
      isDesktop = next;
      for (const listener of listeners) listener();
    },
  };
}

async function openArtifact(prompt = "html page") {
  const user = userEvent.setup();
  render(<Studio transport={mockTransport({ toolSteps: 0 })} />);
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${prompt}{Enter}`);
  await screen.findAllByText("Ready");
  return user;
}

const chatPane = () => document.getElementById("chat-pane") as HTMLElement;
const canvasPane = () => document.getElementById("canvas-pane") as HTMLElement;

describe("StudioLayout — desktop", () => {
  it("gives the chat the full width until an artifact opens, then splits 40/60", async () => {
    render(<Studio transport={mockTransport({ toolSteps: 0 })} />);
    expect(chatPane().style.width).toBe("100%");
    expect(canvasPane()).not.toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas" })).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "html page{Enter}");
    await screen.findAllByText("Ready");
    expect(chatPane().style.width).toBe("40%");
    expect(canvasPane()).toBeVisible();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "40");
  });

  it("resizes with the keyboard and remembers the split", async () => {
    const user = await openArtifact();
    screen.getByRole("separator").focus();
    await user.keyboard("{PageUp}{ArrowRight}");
    expect(chatPane().style.width).toBe("52%");
    await waitFor(() => expect(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY)).toBe("0.52"));
  });

  it("resizes by dragging, without width transitions while dragging", async () => {
    await openArtifact();
    const container = chatPane().parentElement as HTMLElement;
    container.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
    const splitter = screen.getByRole("separator");

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 1, clientX: 400 });
    expect(chatPane().className).not.toContain("transition-[width]");
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 650 });
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 650 });
    expect(chatPane().style.width).toBe("65%");
    expect(chatPane().className).toContain("transition-[width]");
  });

  it("restores a remembered split ratio on load", async () => {
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, "0.3");
    await openArtifact();
    expect(chatPane().style.width).toBe("30%");
  });

  it("hides and reopens the canvas from the header and the toolbar", async () => {
    const user = await openArtifact();
    const toggle = screen.getByRole("button", { name: "Canvas" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await user.click(within(canvasPane()).getByRole("button", { name: "Hide canvas" }));
    expect(chatPane().style.width).toBe("100%");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(chatPane().style.width).toBe("40%");
    await user.click(toggle);
    expect(canvasPane()).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Open .* in canvas$/ }));
    expect(canvasPane()).toBeVisible();
  });
});

describe("StudioLayout — mobile", () => {
  it("shows one pane at a time and switches to the canvas when an artifact opens", async () => {
    stubViewport(false);
    const user = await openArtifact();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(chatPane()).not.toBeVisible();
    expect(chatPane().style.width).toBe("100%");

    await user.click(screen.getByRole("tab", { name: "Chat" }));
    expect(chatPane()).toBeVisible();
    expect(canvasPane()).not.toBeVisible();
  });

  it("follows viewport changes", async () => {
    const viewport = stubViewport(true);
    await openArtifact();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    act(() => viewport.resize(false));
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Pane" })).toBeInTheDocument();
  });
});

describe("split ratio storage", () => {
  it.each([
    [null, null],
    ["0.5", 0.5],
    ["0.1", null],
    ["0.95", null],
    ["wide", null],
  ])("reads %j as %j", (stored, expected) => {
    if (stored !== null) localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, stored);
    expect(readStoredSplitRatio()).toBe(expected);
    localStorage.clear();
  });

  it("survives blocked storage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readStoredSplitRatio()).toBeNull();
    expect(() => writeStoredSplitRatio(0.5)).not.toThrow();
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  });

  it("rounds stored values", () => {
    writeStoredSplitRatio(0.123456);
    expect(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY)).toBe("0.123");
    localStorage.clear();
  });
});

function Orphan() {
  useStudio();
  return null;
}

describe("useStudio", () => {
  it("throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Orphan />)).toThrow("useStudio must be used inside <StudioProvider>");
  });
});
