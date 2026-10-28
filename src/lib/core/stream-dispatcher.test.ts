import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@/lib/schemas";
import { validEvents } from "~tests/fixtures/schemas";

import { consumeEventStream, type StreamChunk } from "./stream-dispatcher";

const encoder = new TextEncoder();
const sse = (event: unknown, id?: string) =>
  `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;
const DONE = "data: [DONE]\n\n";

/** A pull-based byte stream that records how far it was read and whether it was cancelled. */
function byteStream(chunks: (string | Uint8Array)[], options: { error?: Error } = {}) {
  const state = { pulls: 0, cancelled: false as boolean, cancelReason: undefined as unknown };
  const queue = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));
  const stream = new ReadableStream<StreamChunk>(
    {
      pull(controller) {
        state.pulls++;
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(next);
        else if (options.error) controller.error(options.error);
        else controller.close();
      },
      cancel(reason) {
        state.cancelled = true;
        state.cancelReason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** A stream that delivers `chunks` and then never produces anything else. */
function stallingStream(chunks: string[]) {
  const state = { pulls: 0, cancelled: false as boolean };
  const queue = [...chunks];
  const stream = new ReadableStream<StreamChunk>(
    {
      pull(controller) {
        state.pulls++;
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(encoder.encode(next));
        return new Promise(() => undefined);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const textDelta = (delta: string) => ({ ...validEvents["text-delta"], delta });

describe("consumeEventStream — happy path", () => {
  it("dispatches typed events in order and stops at [DONE]", async () => {
    const { stream, state } = byteStream([
      sse(validEvents["start-message"], "1"),
      sse(textDelta("Hel")) + sse(textDelta("lo"), "3"),
      DONE,
      sse(textDelta("never read")),
    ]);
    const seen: string[] = [];
    const deltas: string[] = [];
    const metas: unknown[] = [];
    const onDone = vi.fn();

    const outcome = await consumeEventStream(stream, {
      handlers: {
        onEvent: (event, meta) => {
          seen.push(event.type);
          metas.push(meta);
        },
        on: { "text-delta": (event) => void deltas.push(event.delta) },
        onDone,
      },
    });

    expect(seen).toEqual(["start-message", "text-delta", "text-delta"]);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(metas).toEqual([
      { index: 0, lastEventId: "1" },
      { index: 1, lastEventId: "1" },
      { index: 2, lastEventId: "3" },
    ]);
    expect(onDone).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      status: "done",
      events: 3,
      heartbeats: 0,
      parseErrors: 0,
      lastEventId: "3",
      discardedTail: false,
    });
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBe(3);
    expect(stream.locked).toBe(false);
  });

  it("dispatches every event type to its own handler", async () => {
    const events = Object.values(validEvents) as StreamEvent[];
    const { stream } = byteStream(events.map((event) => sse(event)));
    const received: StreamEvent[] = [];
    const on = Object.fromEntries(
      events.map((event) => [event.type, (e: StreamEvent) => void received.push(e)]),
    );

    const outcome = await consumeEventStream(stream, { handlers: { on } });

    expect(received).toEqual(events);
    expect(outcome.status).toBe("ended");
  });

  it("reports a stream that ends without [DONE]", async () => {
    const { stream } = byteStream([sse(textDelta("a"))]);
    expect(await consumeEventStream(stream)).toMatchObject({ status: "ended", events: 1 });
  });

  it("accepts string chunks", async () => {
    const stream = new ReadableStream<StreamChunk>({
      start(controller) {
        controller.enqueue(sse(textDelta("a")));
        controller.enqueue(DONE);
        controller.close();
      },
    });
    expect(await consumeEventStream(stream)).toMatchObject({ status: "done", events: 1 });
  });

  it("counts heartbeats and comment frames", async () => {
    const onHeartbeat = vi.fn();
    const { stream } = byteStream([
      ": keep-alive\n\n",
      "retry: 100\n\n",
      sse(textDelta("a")),
      DONE,
    ]);
    const outcome = await consumeEventStream(stream, { handlers: { onHeartbeat } });
    expect(outcome).toMatchObject({ status: "done", heartbeats: 2, events: 1 });
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
  });
});

describe("consumeEventStream — fragmentation", () => {
  it("reassembles frames split at every byte", async () => {
    const payload = encoder.encode(sse(textDelta("zażółć 🦊")) + sse(textDelta("b")) + DONE);
    const chunks = [...payload].map((byte) => Uint8Array.of(byte));
    const deltas: string[] = [];
    const { stream } = byteStream(chunks);

    const outcome = await consumeEventStream(stream, {
      handlers: { on: { "text-delta": (event) => void deltas.push(event.delta) } },
    });

    expect(deltas).toEqual(["zażółć 🦊", "b"]);
    expect(outcome).toMatchObject({ status: "done", events: 2, parseErrors: 0 });
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode(sse(textDelta("é")));
    const split = bytes.indexOf(0xc3) + 1;
    const { stream } = byteStream([bytes.slice(0, split), bytes.slice(split)]);
    const onEvent = vi.fn();
    await consumeEventStream(stream, { handlers: { onEvent } });
    expect(onEvent).toHaveBeenCalledWith(textDelta("é"), expect.anything());
  });

  it("drops an unterminated trailing event and reports it", async () => {
    const { stream } = byteStream([sse(textDelta("a")), `data: ${JSON.stringify(textDelta("b"))}`]);
    const onEvent = vi.fn();
    const outcome = await consumeEventStream(stream, { handlers: { onEvent } });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ status: "ended", discardedTail: true });
  });

  it("flushes a truncated multi-byte character at end of stream into a discarded tail", async () => {
    const { stream } = byteStream([sse(textDelta("a")), Uint8Array.of(0x64, 0x61, 0xc3)]);
    const outcome = await consumeEventStream(stream);
    expect(outcome).toMatchObject({ status: "ended", events: 1, discardedTail: true });
  });

  it("flushes a frame completed only by the final chunk", async () => {
    const frame = sse(textDelta("a"));
    const { stream } = byteStream([frame.slice(0, -1), frame.slice(-1)]);
    expect(await consumeEventStream(stream)).toMatchObject({ events: 1, discardedTail: false });
  });
});

describe("consumeEventStream — broken frames", () => {
  it("skips malformed frames, reports them and keeps going", async () => {
    const onParseError = vi.fn();
    const { stream } = byteStream([
      "data: {not json\n\n",
      sse({ type: "text-delta", messageId: "m" }),
      `event: finish-message\n${sse(textDelta("x"))}`,
      "data:\n\n",
      sse(textDelta("ok")),
      DONE,
    ]);
    const outcome = await consumeEventStream(stream, { handlers: { onParseError } });

    expect(onParseError.mock.calls.map(([error]) => error.code)).toEqual([
      "invalid-json",
      "invalid-event",
      "event-mismatch",
      "empty",
    ]);
    expect(outcome).toMatchObject({ status: "done", events: 1, parseErrors: 4 });
  });

  it("gives up after too many consecutive malformed frames", async () => {
    const { stream, state } = byteStream(["data: x\n\n".repeat(3), sse(textDelta("unreached"))]);
    const outcome = await consumeEventStream(stream, { maxConsecutiveParseErrors: 3 });

    expect(outcome.status).toBe("failed");
    expect(outcome.parseErrors).toBe(3);
    expect(outcome.problem).toMatchObject({ code: "invalid_frame", status: 502 });
    expect(outcome.problem?.detail).toMatch(/^3 consecutive malformed frames; last: /);
    expect(state.cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("resets the consecutive-error count after a valid event", async () => {
    const bad = "data: x\n\n";
    const { stream } = byteStream([bad, bad, sse(textDelta("a")), bad, bad, DONE]);
    const outcome = await consumeEventStream(stream, { maxConsecutiveParseErrors: 3 });
    expect(outcome).toMatchObject({ status: "done", parseErrors: 4 });
  });

  it("treats an oversized frame as a parse error and recovers", async () => {
    const onParseError = vi.fn();
    const { stream } = byteStream([`data: ${"x".repeat(200)}\n\n`, sse(textDelta("a")), DONE]);
    const outcome = await consumeEventStream(stream, {
      maxFrameChars: 100,
      handlers: { onParseError },
    });
    expect(onParseError).toHaveBeenCalledWith(expect.objectContaining({ code: "too-large" }));
    expect(outcome).toMatchObject({ status: "done", events: 1, parseErrors: 1 });
  });

  it("fails when an oversized frame exhausts the error budget", async () => {
    const { stream } = byteStream([`data: ${"x".repeat(200)}\n\n`]);
    const outcome = await consumeEventStream(stream, {
      maxFrameChars: 100,
      maxConsecutiveParseErrors: 1,
    });
    expect(outcome).toMatchObject({ status: "failed", problem: { code: "invalid_frame" } });
  });

  it("fails when the trailing frames exhaust the error budget", async () => {
    const { stream } = byteStream(["data: x\n", "\n"]);
    const outcome = await consumeEventStream(stream, { maxConsecutiveParseErrors: 1 });
    expect(outcome.status).toBe("failed");
  });
});

describe("consumeEventStream — aborts and failures", () => {
  it("returns immediately for an already-aborted signal", async () => {
    const { stream, state } = byteStream([sse(textDelta("a"))]);
    const outcome = await consumeEventStream(stream, { signal: AbortSignal.abort("stop") });
    expect(outcome).toMatchObject({ status: "aborted", events: 0 });
    expect(state.cancelled).toBe(true);
    expect(state.cancelReason).toBe("stop");
  });

  it("aborts a stalled stream and cleans up", async () => {
    const { stream, state } = stallingStream([sse(textDelta("a"))]);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const pending = consumeEventStream(stream, {
      signal: controller.signal,
      handlers: { onEvent: () => controller.abort() },
    });
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "aborted", events: 1 });
    expect(state.cancelled).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(stream.locked).toBe(false);
  });

  it("aborts while waiting for the next chunk", async () => {
    const { stream, state } = stallingStream([]);
    const controller = new AbortController();
    const pending = consumeEventStream(stream, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ status: "aborted" });
    expect(state.cancelled).toBe(true);
  });

  it("stops dispatching the rest of a chunk once aborted by a handler", async () => {
    const controller = new AbortController();
    const onEvent = vi.fn(() => controller.abort());
    const { stream } = byteStream([sse(textDelta("a")) + sse(textDelta("b"))]);
    const outcome = await consumeEventStream(stream, {
      signal: controller.signal,
      handlers: { onEvent },
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(outcome.status).toBe("aborted");
  });

  it("reports a read error as an interrupted stream", async () => {
    const error = new Error("socket hang up");
    const { stream } = byteStream([sse(textDelta("a"))], { error });
    const outcome = await consumeEventStream(stream);
    expect(outcome).toMatchObject({
      status: "failed",
      events: 1,
      cause: error,
      problem: { code: "stream_interrupted", retryable: true },
    });
  });

  it("contains a throwing handler, cancels the source and surfaces the cause", async () => {
    const boom = new Error("render failed");
    const { stream, state } = byteStream([sse(textDelta("a")), sse(textDelta("b"))]);
    const outcome = await consumeEventStream(stream, {
      handlers: {
        onEvent: () => {
          throw boom;
        },
      },
    });
    expect(outcome).toMatchObject({ status: "failed", cause: boom, problem: { code: "internal" } });
    expect(state.cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("contains a handler rejecting asynchronously", async () => {
    const { stream } = byteStream([DONE]);
    const outcome = await consumeEventStream(stream, {
      handlers: { onDone: () => Promise.reject(new Error("late")) },
    });
    expect(outcome).toMatchObject({ status: "failed", problem: { code: "internal" } });
  });
});

describe("consumeEventStream — backpressure", () => {
  it("does not read further chunks until an async handler settles", async () => {
    const { stream, state } = byteStream([sse(textDelta("a")), sse(textDelta("b")), DONE]);
    let release: () => void = () => undefined;
    const handled: string[] = [];

    const pending = consumeEventStream(stream, {
      handlers: {
        on: {
          "text-delta": async (event) => {
            if (event.delta === "a") await new Promise<void>((resolve) => (release = resolve));
            handled.push(event.delta);
          },
        },
      },
    });

    await vi.waitFor(() => expect(state.pulls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.pulls).toBe(1);
    expect(handled).toEqual([]);

    release();
    expect(await pending).toMatchObject({ status: "done", events: 2 });
    expect(handled).toEqual(["a", "b"]);
  });
});

describe("consumeEventStream — async iterable sources", () => {
  it("consumes an async generator and closes it on [DONE]", async () => {
    let closed = false;
    async function* source() {
      try {
        yield sse(textDelta("a"));
        yield encoder.encode(DONE);
        yield sse(textDelta("unreached"));
      } finally {
        closed = true;
      }
    }
    expect(await consumeEventStream(source())).toMatchObject({ status: "done", events: 1 });
    expect(closed).toBe(true);
  });

  it("runs an async iterable to completion", async () => {
    async function* source() {
      yield sse(textDelta("a"));
    }
    expect(await consumeEventStream(source())).toMatchObject({ status: "ended", events: 1 });
  });

  it("works with iterators that have no return()", async () => {
    const chunks = [sse(textDelta("a")), DONE];
    const iterable: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const value = chunks.shift();
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
      }),
    };
    expect(await consumeEventStream(iterable)).toMatchObject({ status: "done" });
  });

  it("aborts an iterable whose next() never settles without leaking a rejection", async () => {
    const controller = new AbortController();
    const iterable: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 5)),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    const pending = consumeEventStream(iterable, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
