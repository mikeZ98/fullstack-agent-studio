"use client";

import { RotateCcw, Sparkles, TriangleAlert } from "lucide-react";

import { useState } from "react";

import { BLOCKING_VIOLATIONS, VIOLATION_MESSAGES } from "@/lib/guardrails/input-guardrails";
import { ProblemDetailsSchema } from "@/lib/schemas";

import { useStudio } from "../studio-provider";
import { Button } from "../ui/button";
import { ChatInput } from "./chat-input";
import { MessageList } from "./message-list";

export const EXAMPLE_PROMPTS = [
  "Build a React todo list component",
  "Make an HTML landing page with a counter",
  "Draw a mermaid flow chart of a login flow",
] as const;

/** The server reports failures as RFC 9457 JSON; anything else is shown verbatim. */
export function describeError(error: Error): { title: string; detail: string | undefined } {
  try {
    const problem = ProblemDetailsSchema.parse(JSON.parse(error.message));
    return { title: problem.title, detail: problem.detail };
  } catch {
    return { title: "Something went wrong", detail: error.message || undefined };
  }
}

export function ChatPanel() {
  const { chat, sendUserMessage } = useStudio();
  const { messages, status, error, stop, regenerate } = chat;
  const busy = status === "submitted" || status === "streaming";
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const problem = error === undefined ? null : describeError(error);

  // Pre-submission input guardrails: refused messages stay in the field, with the reasons.
  function send(text: string): boolean {
    const assessment = sendUserMessage(text);
    const blocking = assessment.violations.filter((violation) =>
      BLOCKING_VIOLATIONS.has(violation),
    );
    setRefusal(
      assessment.allowed ? null : blocking.map((violation) => VIOLATION_MESSAGES[violation]),
    );
    return assessment.allowed;
  }

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <Sparkles aria-hidden className="size-8 text-blue-500" />
          <div>
            <h2 className="text-lg font-semibold">What should we build?</h2>
            <p className="mt-1 text-sm text-muted-foreground">Artifacts open live in the canvas.</p>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Example prompts">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <li key={prompt}>
                <Button variant="outline" size="sm" onClick={() => send(prompt)} disabled={busy}>
                  {prompt}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <MessageList messages={messages} streaming={status === "streaming"} />
      )}

      {problem !== null && (
        <div
          role="alert"
          className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{problem.title}</p>
            {problem.detail !== undefined && (
              <p className="text-muted-foreground">{problem.detail}</p>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => void regenerate()}>
            <RotateCcw aria-hidden className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      <div className="p-3 pt-1">
        {refusal !== null && (
          <div
            role="alert"
            aria-label="Message not sent"
            className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-sm"
          >
            <p className="font-medium">This message was not sent.</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {refusal.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        <ChatInput onSubmit={send} onStop={() => void stop()} busy={busy} />
      </div>
    </section>
  );
}
