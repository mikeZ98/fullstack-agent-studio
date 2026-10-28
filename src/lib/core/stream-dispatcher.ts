import {
  createProblem,
  LIMITS,
  type ProblemDetails,
  parseSseFrame,
  type StreamEvent,
  type StreamEventType,
  type StreamParseError,
  streamParseErrorToProblem,
} from "@/lib/schemas";

import { createSseFramer, type FramerOutput } from "./sse-framer";

export type StreamChunk = Uint8Array | string;
export type StreamSource = ReadableStream<StreamChunk> | AsyncIterable<StreamChunk>;

type Awaitable<T> = T | Promise<T>;

export interface EventMeta {
  /** Zero-based index of the event within this stream. */
  index: number;
  /** Last SSE `id:` seen so far (sticky across events, per the SSE spec). */
  lastEventId: string | undefined;
}

export type StreamEventHandlers = {
  [K in StreamEventType]?: (
    event: Extract<StreamEvent, { type: K }>,
    meta: EventMeta,
  ) => Awaitable<void>;
};

/**
 * Callbacks run sequentially: the next frame is not processed, and the next chunk not
 * read, until the returned promise settles. Slow consumers therefore apply backpressure to
 * the network stream instead of growing an in-memory queue.
 */
export interface StreamHandlers {
  onEvent?: (event: StreamEvent, meta: EventMeta) => Awaitable<void>;
  /** Per-type handlers, called after `onEvent`. */
  on?: StreamEventHandlers;
  /** Comment-only / data-less frames (keep-alives). */
  onHeartbeat?: () => Awaitable<void>;
  /** A malformed frame was skipped; the stream continues. */
  onParseError?: (error: StreamParseError) => Awaitable<void>;
  /** The `[DONE]` sentinel arrived; the rest of the stream is cancelled. */
  onDone?: () => Awaitable<void>;
}

export interface ConsumeStreamOptions {
  handlers?: StreamHandlers;
  signal?: AbortSignal;
  /** Malformed frames in a row before giving up on the stream. */
  maxConsecutiveParseErrors?: number;
  maxFrameChars?: number;
}

export type StreamStatus =
  /** `[DONE]` received. */
  | "done"
  /** Source ended without `[DONE]`. */
  | "ended"
  | "aborted"
  /** Read error, handler error, or too many malformed frames; see `problem`. */
  | "failed";

export interface StreamOutcome {
  status: StreamStatus;
  events: number;
  heartbeats: number;
  parseErrors: number;
  lastEventId: string | undefined;
  /** An unterminated trailing event was dropped at end of stream. */
  discardedTail: boolean;
  problem?: ProblemDetails;
  /** The underlying error for `failed` outcomes. */
  cause?: unknown;
}

type ReadResult = { done: true } | { done: false; value: StreamChunk };

interface ChunkReader {
  read(): Promise<ReadResult>;
  cancel(reason: unknown): Promise<void>;
  release(): void;
}

function openReader(source: StreamSource): ChunkReader {
  if ("getReader" in source) {
    const reader = source.getReader();
    return {
      read: async () => {
        const result = await reader.read();
        return result.done ? { done: true } : { done: false, value: result.value };
      },
      cancel: (reason) => reader.cancel(reason).catch(() => undefined),
      release: () => reader.releaseLock(),
    };
  }
  const iterator = source[Symbol.asyncIterator]();
  return {
    read: async () => {
      const result = await iterator.next();
      return result.done === true ? { done: true } : { done: false, value: result.value };
    },
    cancel: async () => {
      await iterator.return?.()?.catch(() => undefined);
    },
    release: () => undefined,
  };
}

/** Wraps errors thrown by consumer callbacks so they are not mistaken for read errors. */
class HandlerError extends Error {
  constructor(override readonly cause: unknown) {
    super("Stream handler threw");
    this.name = "HandlerError";
  }
}

async function invoke<A extends unknown[]>(
  handler: ((...args: A) => Awaitable<void>) | undefined,
  ...args: A
): Promise<void> {
  if (handler === undefined) return;
  try {
    await handler(...args);
  } catch (error) {
    throw new HandlerError(error);
  }
}

const ABORTED = Symbol("aborted");

/**
 * Consume an SSE byte or text stream, validating every frame against the stream protocol
 * and dispatching typed events. Never throws: every way the stream can end is reported in
 * the returned outcome, and the source is always cancelled or released, with the abort
 * listener removed, before this resolves.
 */
export async function consumeEventStream(
  source: StreamSource,
  options: ConsumeStreamOptions = {},
): Promise<StreamOutcome> {
  const {
    handlers = {},
    signal,
    maxConsecutiveParseErrors = LIMITS.consecutiveParseErrors,
    maxFrameChars = LIMITS.frameBytes,
  } = options;

  const reader = openReader(source);
  const decoder = new TextDecoder();
  const framer = createSseFramer(maxFrameChars);
  const stats = { events: 0, heartbeats: 0, parseErrors: 0, consecutiveErrors: 0 };
  let lastEventId: string | undefined;
  let discardedTail = false;

  const outcome = (status: StreamStatus, extra: Pick<StreamOutcome, "problem" | "cause"> = {}) => {
    const { events, heartbeats, parseErrors } = stats;
    return { status, events, heartbeats, parseErrors, lastEventId, discardedTail, ...extra };
  };

  const abort = Promise.withResolvers<typeof ABORTED>();
  const onAbort = () => abort.resolve(ABORTED);
  signal?.addEventListener("abort", onAbort, { once: true });

  async function handleParseError(error: StreamParseError): Promise<StreamOutcome | null> {
    stats.parseErrors++;
    stats.consecutiveErrors++;
    await invoke(handlers.onParseError, error);
    if (stats.consecutiveErrors < maxConsecutiveParseErrors) return null;
    const problem = streamParseErrorToProblem({
      ...error,
      message: `${stats.consecutiveErrors} consecutive malformed frames; last: ${error.message}`,
    });
    return outcome("failed", { problem });
  }

  /** Returns a terminal outcome, or null to keep reading. */
  async function process(outputs: FramerOutput[]): Promise<StreamOutcome | null> {
    for (const output of outputs) {
      if (signal?.aborted) return outcome("aborted");
      if (output.kind === "overflow") {
        const message = `SSE frame exceeds ${maxFrameChars} characters`;
        const verdict = await handleParseError({ code: "too-large", message, issues: [] });
        if (verdict) return verdict;
        continue;
      }
      const frame = parseSseFrame(output.text);
      switch (frame.kind) {
        case "heartbeat":
          stats.heartbeats++;
          await invoke(handlers.onHeartbeat);
          break;
        case "done":
          await invoke(handlers.onDone);
          return outcome("done");
        case "error": {
          const verdict = await handleParseError(frame.error);
          if (verdict) return verdict;
          break;
        }
        case "event": {
          stats.consecutiveErrors = 0;
          if (frame.id !== undefined) lastEventId = frame.id;
          const meta: EventMeta = { index: stats.events++, lastEventId };
          await invoke(handlers.onEvent, frame.event, meta);
          const typed = handlers.on?.[frame.event.type] as StreamHandlers["onEvent"];
          await invoke(typed, frame.event, meta);
          break;
        }
      }
    }
    return signal?.aborted ? outcome("aborted") : null;
  }

  try {
    if (signal?.aborted) {
      await reader.cancel(signal.reason);
      return outcome("aborted");
    }
    for (;;) {
      const read = reader.read();
      // The read may reject after an abort has already won the race; never leave it unhandled.
      read.catch(() => undefined);
      const result = await Promise.race([read, abort.promise]);
      if (result === ABORTED) {
        await reader.cancel(signal?.reason);
        return outcome("aborted");
      }
      if (result.done) break;
      const text =
        typeof result.value === "string"
          ? result.value
          : decoder.decode(result.value, { stream: true });
      const verdict = await process(framer.push(text));
      if (verdict) {
        await reader.cancel(verdict.status);
        return verdict;
      }
    }
    const tail = decoder.decode();
    const pushed = tail === "" ? [] : framer.push(tail);
    const finished = framer.finish();
    discardedTail = finished.discardedTail;
    return (await process([...pushed, ...finished.outputs])) ?? outcome("ended");
  } catch (error) {
    if (error instanceof HandlerError) {
      await reader.cancel(error);
      return outcome("failed", {
        problem: createProblem("internal", { detail: "A stream event handler threw" }),
        cause: error.cause,
      });
    }
    return outcome("failed", {
      problem: createProblem("stream_interrupted", { detail: "Reading the stream failed" }),
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.release();
  }
}
