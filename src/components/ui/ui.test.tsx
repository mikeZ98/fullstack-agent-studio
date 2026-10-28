import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "./badge";
import { Button } from "./button";
import { ResizableSplitter } from "./resizable-splitter";
import { ScrollArea } from "./scroll-area";
import { Select } from "./select";
import { Tabs } from "./tabs";
import { Tooltip } from "./tooltip";

describe("Button", () => {
  it("defaults to a non-submitting button and forwards props", async () => {
    const onClick = vi.fn();
    render(
      <form onSubmit={() => {}}>
        <Button onClick={onClick} variant="danger" size="sm" className="extra">
          Delete
        </Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("bg-red-600");
    expect(button.className).toContain("extra");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("accepts a ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} type="submit" />);
    expect(ref.current).toHaveAttribute("type", "submit");
  });
});

describe("Badge, Tooltip, ScrollArea, Select", () => {
  it("renders a toned badge", () => {
    render(<Badge tone="success">Ready</Badge>);
    expect(screen.getByText("Ready").className).toContain("text-green-700");
  });

  it("renders a decorative tooltip next to its control", () => {
    render(
      <Tooltip label="Copy source" side="top">
        <button type="button" aria-label="Copy" />
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    const hint = screen.getByText("Copy source");
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(hint.className).toContain("bottom-full");
  });

  it("renders a scroll region that accepts a ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ScrollArea ref={ref} aria-label="Log" role="log" />);
    expect(screen.getByRole("log", { name: "Log" })).toBe(ref.current);
  });

  it("renders a native select with options", async () => {
    const onChange = vi.fn();
    render(
      <Select
        aria-label="Revision"
        value="1"
        onChange={(event) => onChange(event.target.value)}
        options={[
          { value: "1", label: "v1" },
          { value: "2", label: "v2" },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Revision" }), "2");
    expect(onChange).toHaveBeenCalledWith("2");
  });
});

function ControlledTabs({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("a");
  return (
    <Tabs
      label="Mode"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      items={[
        { value: "a", label: "A" },
        { value: "b", label: "B", disabled: true },
        { value: "c", label: "C" },
        { value: "d", label: "D" },
      ]}
    />
  );
}

describe("Tabs", () => {
  const selected = () => screen.getByRole("tab", { selected: true }).textContent;

  it("exposes one tab stop and selects on click", async () => {
    render(<ControlledTabs />);
    expect(screen.getByRole("tablist", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "C" })).toHaveAttribute("tabindex", "-1");
    await userEvent.click(screen.getByRole("tab", { name: "D" }));
    expect(selected()).toBe("D");
  });

  it("moves with arrow keys, skipping disabled tabs and wrapping", async () => {
    const user = userEvent.setup();
    render(<ControlledTabs />);
    screen.getByRole("tab", { name: "A" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(selected()).toBe("C");
    expect(screen.getByRole("tab", { name: "C" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toBe("A");
    await user.keyboard("{ArrowLeft}");
    expect(selected()).toBe("D");
    await user.keyboard("{ArrowUp}");
    expect(selected()).toBe("C");
  });

  it("jumps with Home and End and ignores other keys", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledTabs onChange={onChange} />);
    screen.getByRole("tab", { name: "A" }).focus();
    await user.keyboard("{End}");
    expect(selected()).toBe("D");
    await user.keyboard("{Home}");
    expect(selected()).toBe("A");
    onChange.mockClear();
    await user.keyboard("x");
    expect(onChange).not.toHaveBeenCalled();
  });
});

function SplitterHarness(props: {
  onDraggingChange?: (dragging: boolean) => void;
  width?: number;
}) {
  const [value, setValue] = useState(0.4);
  const containerRef = { current: null as HTMLDivElement | null };
  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        if (node) {
          node.getBoundingClientRect = () => ({ left: 100, width: props.width ?? 1000 }) as DOMRect;
        }
      }}
    >
      <div id="pane" />
      <ResizableSplitter
        label="Resize"
        controls="pane"
        containerRef={containerRef}
        value={value}
        min={0.2}
        max={0.8}
        defaultValue={0.4}
        onChange={setValue}
        {...(props.onDraggingChange === undefined
          ? {}
          : { onDraggingChange: props.onDraggingChange })}
      />
    </div>
  );
}

describe("ResizableSplitter", () => {
  const splitter = () => screen.getByRole("separator", { name: "Resize" });
  const now = () => splitter().getAttribute("aria-valuenow");

  it("exposes the window splitter semantics", () => {
    render(<SplitterHarness />);
    expect(splitter()).toHaveAttribute("aria-orientation", "vertical");
    expect(splitter()).toHaveAttribute("aria-controls", "pane");
    expect(splitter()).toHaveAttribute("aria-valuemin", "20");
    expect(splitter()).toHaveAttribute("aria-valuemax", "80");
    expect(now()).toBe("40");
  });

  it.each([
    ["{ArrowRight}", "42"],
    ["{ArrowUp}", "42"],
    ["{ArrowLeft}", "38"],
    ["{ArrowDown}", "38"],
    ["{PageUp}", "50"],
    ["{PageDown}", "30"],
    ["{Home}", "20"],
    ["{End}", "80"],
  ])("responds to %s", async (key, expected) => {
    const user = userEvent.setup();
    render(<SplitterHarness />);
    splitter().focus();
    await user.keyboard(key);
    expect(now()).toBe(expected);
  });

  it("clamps keyboard moves to the bounds and ignores other keys", async () => {
    const user = userEvent.setup();
    render(<SplitterHarness />);
    splitter().focus();
    await user.keyboard("{End}{ArrowRight}{PageUp}");
    expect(now()).toBe("80");
    await user.keyboard("a");
    expect(now()).toBe("80");
  });

  it("follows a pointer drag, clamped, and reports dragging", () => {
    const onDraggingChange = vi.fn();
    render(<SplitterHarness onDraggingChange={onDraggingChange} />);
    fireEvent.pointerDown(splitter(), { button: 0, pointerId: 1, clientX: 500 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(splitter(), { pointerId: 1, clientX: 700 });
    expect(now()).toBe("60");
    fireEvent.pointerMove(splitter(), { pointerId: 1, clientX: 1100 });
    expect(now()).toBe("80");
    fireEvent.pointerUp(splitter(), { pointerId: 1, clientX: 1100 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    fireEvent.pointerMove(splitter(), { pointerId: 1, clientX: 300 });
    expect(now()).toBe("80");
  });

  it("ignores secondary buttons, stray pointer-ups and an unmeasured container", () => {
    const onDraggingChange = vi.fn();
    render(<SplitterHarness onDraggingChange={onDraggingChange} width={0} />);
    fireEvent.pointerDown(splitter(), { button: 2, clientX: 500 });
    fireEvent.pointerUp(splitter(), { clientX: 500 });
    expect(onDraggingChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(splitter(), { button: 0, clientX: 500 });
    fireEvent.pointerMove(splitter(), { clientX: 700 });
    expect(now()).toBe("40");
    fireEvent.pointerCancel(splitter(), { clientX: 700 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it("captures the pointer when supported and resets on double-click", async () => {
    render(<SplitterHarness />);
    const element = splitter();
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(element, { setPointerCapture: capture, releasePointerCapture: release });
    fireEvent.pointerDown(element, { button: 0, pointerId: 7, clientX: 800 });
    fireEvent.pointerMove(element, { pointerId: 7, clientX: 800 });
    fireEvent.pointerUp(element, { pointerId: 7 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledWith(7);
    expect(now()).toBe("70");
    await userEvent.dblClick(element);
    expect(now()).toBe("40");
  });
});
