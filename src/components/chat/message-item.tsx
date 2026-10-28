"use client";

import { Sparkles, User } from "lucide-react";
import { memo } from "react";

import type { StudioUIMessage } from "@/lib/schemas";
import { cn } from "@/lib/utils";

import { Markdown } from "../markdown";
import { InlineArtifactCard } from "./inline-artifact-card";
import { ToolCallCard } from "./tool-call-card";

export interface MessageItemProps {
  message: StudioUIMessage;
  /** This message is the one currently being generated. */
  streaming?: boolean;
}

function MessagePart({
  part,
  isUser,
}: {
  part: StudioUIMessage["parts"][number];
  isUser: boolean;
}) {
  switch (part.type) {
    case "text":
      return isUser ? (
        <p className="text-sm break-words whitespace-pre-wrap">{part.text}</p>
      ) : (
        <Markdown source={part.text} />
      );
    case "dynamic-tool":
      return (
        <ToolCallCard
          toolName={part.toolName}
          state={part.state}
          input={part.input}
          {...(part.state === "output-available" ? { output: part.output } : {})}
          {...(part.state === "output-error" ? { errorText: part.errorText } : {})}
        />
      );
    case "data-artifact-open":
      return (
        <InlineArtifactCard artifactId={part.data.artifactId} fallbackTitle={part.data.title} />
      );
    default:
      // Step markers, artifact-close markers and reasoning are not rendered.
      return null;
  }
}

/** One chat turn with avatar, rendered parts and a live caret while streaming. */
export const MessageItem = memo(function MessageItem({
  message,
  streaming = false,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const Avatar = isUser ? User : Sparkles;
  return (
    <article
      aria-label={isUser ? "You" : "Assistant"}
      data-role={message.role}
      aria-busy={streaming}
      className={cn("flex gap-3 px-4 py-3", isUser && "flex-row-reverse")}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          isUser
            ? "bg-foreground text-background"
            : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        )}
      >
        <Avatar className="size-3.5" />
      </span>
      <div className={cn("max-w-[85%] min-w-0", isUser && "rounded-2xl bg-muted px-3.5 py-2")}>
        {message.parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts only ever append; index is stable.
          <MessagePart key={index} part={part} isUser={isUser} />
        ))}
        {streaming && (
          <span
            data-testid="streaming-caret"
            aria-hidden
            className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle"
          />
        )}
      </div>
    </article>
  );
});
