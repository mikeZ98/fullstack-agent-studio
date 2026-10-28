import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChatInput, MAX_INPUT_HEIGHT } from "./chat-input";

function setup(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  render(<ChatInput onSubmit={onSubmit} onStop={onStop} busy={false} {...props} />);
  const textbox = screen.getByRole("textbox", { name: "Message" });
  return { onSubmit, onStop, textbox, user: userEvent.setup() };
}

describe("ChatInput", () => {
  it("submits trimmed text on Enter and clears the field", async () => {
    const { onSubmit, textbox, user } = setup();
    await user.type(textbox, "  Build a chart  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Build a chart");
    expect(textbox).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter", async () => {
    const { onSubmit, textbox, user } = setup();
    await user.type(textbox, "line one{Shift>}{Enter}{/Shift}line two");
    expect(textbox).toHaveValue("line one\nline two");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits with the send button", async () => {
    const { onSubmit, textbox, user } = setup();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    await user.type(textbox, "hi");
    expect(send).toBeEnabled();
    await user.click(send);
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("does not submit whitespace", async () => {
    const { onSubmit, textbox, user } = setup();
    await user.type(textbox, "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while an IME composition is in progress", () => {
    const { onSubmit, textbox } = setup();
    fireEvent.change(textbox, { target: { value: "日本" } });
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers Stop instead of Send while busy, and blocks submitting", async () => {
    const { onSubmit, onStop, textbox, user } = setup({ busy: true });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    await user.type(textbox, "next question{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox).toHaveValue("next question");
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("can be disabled entirely", () => {
    const { textbox } = setup({ disabled: true });
    expect(textbox).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("announces the keyboard shortcuts and caps the length", () => {
    const { textbox } = setup();
    expect(textbox).toHaveAccessibleDescription("Press Enter to send, Shift+Enter for a new line.");
    expect(textbox).toHaveAttribute("maxLength", "100000");
  });

  it("grows with its content up to a maximum height, then scrolls", () => {
    const { textbox } = setup();
    let scrollHeight = 60;
    Object.defineProperty(textbox, "scrollHeight", { configurable: true, get: () => scrollHeight });
    fireEvent.change(textbox, { target: { value: "a\nb\nc" } });
    expect(textbox.style.height).toBe("60px");
    expect(textbox.style.overflowY).toBe("hidden");

    scrollHeight = 900;
    fireEvent.change(textbox, { target: { value: "long\n".repeat(50) } });
    expect(textbox.style.height).toBe(`${MAX_INPUT_HEIGHT}px`);
    expect(textbox.style.overflowY).toBe("auto");
  });
});
