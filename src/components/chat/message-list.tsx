"use client";

import { type UIEvent, useLayoutEffect, useRef } from "react";

import type { StudioUIMessage } from "@/lib/schemas";

import { ScrollArea } from "../ui/scroll-area";
import { MessageItem } from "./message-item";

/** How close to the bottom (px) still counts as "following" the conversation. */
export const STICK_TO_BOTTOM_THRESHOLD = 80;

export interface MessageListProps {
  messages: StudioUIMessage[];
  /** The last assistant message is still being generated. */
  streaming: boolean;
}

/**
 * Conversation log. Follows new content while the reader is at the bottom, but never yanks
 * them back down after they scrolled up to read.
 */
export function MessageList({ messages, streaming }: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    following.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_THRESHOLD;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the rendered content changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, streaming]);

  const last = messages.at(-1);
  return (
    <ScrollArea
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      aria-busy={streaming}
      tabIndex={0}
      className="flex-1 scroll-smooth py-2"
    >
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          streaming={streaming && message === last && message.role === "assistant"}
        />
      ))}
    </ScrollArea>
  );
}
