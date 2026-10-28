import { ChevronRight, Wrench } from "lucide-react";

import { Badge, type BadgeTone } from "../ui/badge";

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface ToolCallCardProps {
  toolName: string;
  state: ToolCallState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

const STATES: Readonly<Record<ToolCallState, { label: string; tone: BadgeTone }>> = {
  "input-streaming": { label: "Preparing", tone: "neutral" },
  "input-available": { label: "Running", tone: "info" },
  "approval-requested": { label: "Awaiting approval", tone: "warning" },
  "approval-responded": { label: "Approved", tone: "info" },
  "output-available": { label: "Done", tone: "success" },
  "output-error": { label: "Failed", tone: "danger" },
  "output-denied": { label: "Denied", tone: "warning" },
};

function pretty(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

/** Collapsible visualisation of one tool call and its result. */
export function ToolCallCard({ toolName, state, input, output, errorText }: ToolCallCardProps) {
  const { label, tone } = STATES[state];
  return (
    <details className="group my-2 rounded-lg border bg-muted/30 text-xs" data-tool={toolName}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <Wrench aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="font-mono font-medium">{toolName}</span>
        <Badge tone={tone} className="ml-auto">
          {label}
        </Badge>
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        <section aria-label="Tool input">
          <h4 className="mb-1 font-medium text-muted-foreground">Input</h4>
          <pre className="overflow-x-auto font-mono whitespace-pre-wrap">{pretty(input)}</pre>
        </section>
        {state === "output-available" && (
          <section aria-label="Tool output">
            <h4 className="mb-1 font-medium text-muted-foreground">Output</h4>
            <pre className="overflow-x-auto font-mono whitespace-pre-wrap">{pretty(output)}</pre>
          </section>
        )}
        {state === "output-error" && (
          <p role="alert" className="text-red-700 dark:text-red-300">
            {errorText}
          </p>
        )}
      </div>
    </details>
  );
}
