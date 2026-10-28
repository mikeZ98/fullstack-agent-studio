import type { InferUIMessageChunk, FinishReason as SdkFinishReason } from "ai";

import { consumeEventStream, type StreamOutcome } from "@/lib/core/stream-dispatcher";
import {
  createProblem,
  type FinishReason,
  type ProblemDetails,
  type StreamEvent,
  type StudioUIMessage,
} from "@/lib/schemas";

/**
 * Bridge from the agent backend's SSE protocol to the Vercel AI SDK UI message stream
 * (protocol v1, consumed by `useChat`). Serialization to the wire (`data: {json}\n\n`,
 * `data: [DONE]`) is left to the SDK's own `createUIMessageStreamResponse`, so the
 * framing is exactly what the client parser expects.
 *
 * Artifact lifecycle events become typed `data-artifact-*` parts. Deltas are sent as
 * transient parts: they reach `onData` (and the artifact reducer) but are not stored in
 * the message, so chat history sent back on the next turn stays small.
 */

export type StudioUIMessageChunk = InferUIMessageChunk<StudioUIMessage>;

const FINISH_REASONS: Readonly<Record<FinishReason, SdkFinishReason>> = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool-calls",
  "content-filter": "content-filter",
  error: "error",
  abort: "interrupted",
  other: "other",
};

/** Problems travel in `errorText` as JSON so the client can recover the RFC 9457 envelope. */
export function encodeProblem(problem: ProblemDetails): string {
  return JSON.stringify(problem);
}

/** Stateful, pure mapping of one upstream message's events to UI message chunks. */
export class UIChunkMapper {
  private started = false;
  private finished = false;
  private textPart: string | null = null;
  private textParts = 0;
  private messageId = "message";

  private closeText(out: StudioUIMessageChunk[]): void {
    if (this.textPart === null) return;
    out.push({ type: "text-end", id: this.textPart });
    this.textPart = null;
  }

  private ensureStarted(out: StudioUIMessageChunk[]): void {
    if (this.started) return;
    this.started = true;
    out.push({ type: "start" });
  }

  map(event: StreamEvent): StudioUIMessageChunk[] {
    const out: StudioUIMessageChunk[] = [];
    if (event.type === "start-message") {
      this.closeText(out);
      this.started = true;
      this.messageId = event.messageId;
      out.push({ type: "start", messageId: event.messageId });
      return out;
    }
    this.ensureStarted(out);

    switch (event.type) {
      case "text-delta": {
        if (this.textPart === null) {
          this.textPart = `${this.messageId}-text-${this.textParts++}`;
          out.push({ type: "text-start", id: this.textPart });
        }
        out.push({ type: "text-delta", id: this.textPart, delta: event.delta });
        break;
      }
      case "tool-call": {
        this.closeText(out);
        const { toolCallId, toolName, input } = event;
        out.push({ type: "tool-input-available", toolCallId, toolName, input, dynamic: true });
        break;
      }
      case "tool-result": {
        this.closeText(out);
        const { toolCallId, output } = event;
        out.push(
          event.isError === true
            ? {
                type: "tool-output-error",
                toolCallId,
                errorText: typeof output === "string" ? output : JSON.stringify(output),
                dynamic: true,
              }
            : { type: "tool-output-available", toolCallId, output, dynamic: true },
        );
        break;
      }
      case "artifact-open": {
        this.closeText(out);
        const { type: _type, ...data } = event;
        out.push({ type: "data-artifact-open", data });
        break;
      }
      case "artifact-delta": {
        const { type: _type, ...data } = event;
        out.push({ type: "data-artifact-delta", data, transient: true });
        break;
      }
      case "artifact-close": {
        const { type: _type, ...data } = event;
        out.push({ type: "data-artifact-close", data });
        break;
      }
      case "finish-message": {
        this.closeText(out);
        this.finished = true;
        const { finishReason, usage } = event;
        out.push({
          type: "finish",
          finishReason: FINISH_REASONS[finishReason],
          messageMetadata: usage === undefined ? { finishReason } : { finishReason, usage },
        });
        break;
      }
      case "error": {
        this.closeText(out);
        out.push({ type: "error", errorText: encodeProblem(event.error) });
        break;
      }
    }
    return out;
  }

  /** Chunks that close the message once the upstream stream has ended. */
  finish(outcome: StreamOutcome): StudioUIMessageChunk[] {
    const out: StudioUIMessageChunk[] = [];
    this.closeText(out);
    if (outcome.status === "aborted") {
      out.push({ type: "abort", reason: "client disconnected" });
    } else if (outcome.status === "failed" && outcome.problem !== undefined) {
      out.push({ type: "error", errorText: encodeProblem(outcome.problem) });
    } else if (!this.finished) {
      const detail = "Agent stream ended before the message finished";
      out.push({
        type: "error",
        errorText: encodeProblem(createProblem("stream_interrupted", { detail })),
      });
    }
    return out;
  }
}

export interface BridgeOptions {
  /** Aborting tears down the upstream body (and with it the upstream fetch). */
  signal?: AbortSignal;
  /** Observes how the upstream stream ended, e.g. for logging. */
  onOutcome?: (outcome: StreamOutcome) => void;
}

/**
 * Turn an upstream SSE body into a UI message chunk stream. Backpressure flows end to end:
 * the upstream is read only as fast as the client consumes. Cancelling the returned stream
 * (client disconnect) aborts the upstream read.
 */
export function bridgeAgentStream(
  upstream: ReadableStream<Uint8Array>,
  options: BridgeOptions = {},
): ReadableStream<StudioUIMessageChunk> {
  const mapper = new UIChunkMapper();
  const abort = new AbortController();
  const onCallerAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();

  let wake: (() => void) | undefined;
  let cancelled = false;

  return new ReadableStream<StudioUIMessageChunk>(
    {
      start(controller) {
        const emit = async (chunks: StudioUIMessageChunk[]) => {
          for (const chunk of chunks) if (!cancelled) controller.enqueue(chunk);
          if (!cancelled && (controller.desiredSize ?? 1) <= 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        };
        void (async () => {
          try {
            const outcome = await consumeEventStream(upstream, {
              signal: abort.signal,
              handlers: { onEvent: (event) => emit(mapper.map(event)) },
            });
            options.onOutcome?.(outcome);
            if (cancelled) return;
            for (const chunk of mapper.finish(outcome)) controller.enqueue(chunk);
            controller.close();
          } finally {
            options.signal?.removeEventListener("abort", onCallerAbort);
          }
        })();
      },
      pull() {
        wake?.();
        wake = undefined;
      },
      cancel(reason) {
        cancelled = true;
        abort.abort(reason);
        wake?.();
      },
    },
    { highWaterMark: 16 },
  );
}
