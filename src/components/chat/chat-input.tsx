"use client";

import { ArrowUp, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { LIMITS } from "@/lib/schemas";

import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** Tallest the textarea grows before it scrolls, in pixels. */
export const MAX_INPUT_HEIGHT = 200;

export interface ChatInputProps {
  /** Return `false` to refuse the message and keep it in the field for editing. */
  onSubmit: (text: string) => boolean | undefined;
  onStop: () => void;
  /** A response is being requested or streamed: submitting is blocked, Stop is offered. */
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSubmit,
  onStop,
  busy,
  disabled = false,
  placeholder = "Ask for an app, a page, a diagram…",
}: ChatInputProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSubmit = !busy && !disabled && text.trim() !== "";

  // Grow with the content up to MAX_INPUT_HEIGHT.
  // biome-ignore lint/correctness/useExhaustiveDependencies: must re-measure whenever the text changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    element.style.overflowY = element.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
  }, [text]);

  function submit() {
    if (!canSubmit) return;
    if (onSubmit(text.trim()) !== false) setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline; never send mid IME composition.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function onFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  return (
    <form
      onSubmit={onFormSubmit}
      className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:border-blue-500/60"
    >
      <label htmlFor="chat-input" className="sr-only">
        Message
      </label>
      <textarea
        id="chat-input"
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        maxLength={LIMITS.messageTextChars}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby="chat-input-hint"
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <span id="chat-input-hint" className="sr-only">
        Press Enter to send, Shift+Enter for a new line.
      </span>
      {busy ? (
        <Tooltip label="Stop generating" side="top">
          <Button size="icon" variant="outline" aria-label="Stop generating" onClick={onStop}>
            <Square aria-hidden className="size-3.5 fill-current" />
          </Button>
        </Tooltip>
      ) : (
        <Tooltip label="Send" side="top">
          <Button
            type="submit"
            size="icon"
            variant="primary"
            aria-label="Send message"
            disabled={!canSubmit}
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      )}
    </form>
  );
}
