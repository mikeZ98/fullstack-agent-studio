// @vitest-environment node
import { createUIMessageStreamResponse, readUIMessageStream } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { StreamOutcome } from "@/lib/core/stream-dispatcher";
import { type StudioUIMessage, studioDataPartSchemas } from "@/lib/schemas";
import { agentRequest, collect } from "~tests/fixtures/chat";
import { validEvents, validProblem } from "~tests/fixtures/schemas";

import {
  createMockAgentServer,
  encodeSseEvent,
  MOCK_ARTIFACTS,
  mockAgentFrames,
} from "./mock-agent-provider";
import { bridgeAgentStream, type StudioUIMessageChunk, UIChunkMapper } from "./stream-bridge";

const encoder = new TextEncoder();
const bytes = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const outcome = (
  status: StreamOutcome["status"],
  extra: Partial<StreamOutcome> = {},
): StreamOutcome => ({
  status,
  events: 0,
  heartbeats: 0,
  parseErrors: 0,
  lastEventId: undefined,
  discardedTail: false,
  ...extra,
});

describe("UIChunkMapper", () => {
  it("maps every protocol event to its UI message chunk", () => {
    const mapper = new UIChunkMapper();
    const chunks = Object.values(validEvents).flatMap((event) => mapper.map(event));
    expect(chunks).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "text-start", id: "msg_1-text-0" },
      { type: "text-delta", id: "msg_1-text-0", delta: "Here is your table" },
      { type: "text-end", id: "msg_1-text-0" },
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "web.search",
        input: validEvents["tool-call"].input,
        dynamic: true,
      },
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: validEvents["tool-result"].output,
        dynamic: true,
      },
      {
        type: "data-artifact-open",
        data: {
          messageId: "msg_1",
          artifactId: "art_1",
          revision: 1,
          title: "Pricing table",
          artifactType: "react",
          language: "tsx",
        },
      },
      {
        type: "data-artifact-delta",
        data: {
          messageId: "msg_1",
          artifactId: "art_1",
          revision: 1,
          seq: 0,
          delta: "export default function App() {",
        },
        transient: true,
      },
      {
        type: "data-artifact-close",
        data: { messageId: "msg_1", artifactId: "art_1", revision: 1, contentLength: 31 },
      },
      {
        type: "finish",
        finishReason: "stop",
        messageMetadata: { finishReason: "stop", usage: { inputTokens: 120, outputTokens: 480 } },
      },
      { type: "error", errorText: JSON.stringify(validProblem) },
    ]);
  });

  it("emits data parts that satisfy the Phase 2 data part schemas", () => {
    const mapper = new UIChunkMapper();
    const names = ["artifact-open", "artifact-delta", "artifact-close"] as const;
    for (const name of names) {
      const chunk = mapper.map(validEvents[name]).find((c) => c.type === `data-${name}`);
      if (chunk === undefined || !("data" in chunk)) throw new Error(`no data-${name} chunk`);
      expect(studioDataPartSchemas[name].safeParse(chunk.data).success).toBe(true);
    }
  });

  it("starts a new text part after any interruption", () => {
    const mapper = new UIChunkMapper();
    const text = (delta: string) => ({ ...validEvents["text-delta"], delta });
    const types = [
      validEvents["start-message"],
      text("a"),
      text("b"),
      validEvents["tool-call"],
      text("c"),
      validEvents["finish-message"],
    ].flatMap((event) => mapper.map(event).map((c) => ("id" in c ? `${c.type}:${c.id}` : c.type)));
    expect(types).toEqual([
      "start",
      "text-start:msg_1-text-0",
      "text-delta:msg_1-text-0",
      "text-delta:msg_1-text-0",
      "text-end:msg_1-text-0",
      "tool-input-available",
      "text-start:msg_1-text-1",
      "text-delta:msg_1-text-1",
      "text-end:msg_1-text-1",
      "finish",
    ]);
  });

  it("synthesizes a start chunk when the upstream skipped start-message", () => {
    const chunks = new UIChunkMapper().map(validEvents["text-delta"]);
    expect(chunks.slice(0, 2)).toEqual([
      { type: "start" },
      { type: "text-start", id: "message-text-0" },
    ]);
  });

  it.each([
    ["a string", "boom", "boom"],
    ["an object", { code: 7 }, '{"code":7}'],
  ])("reports a failed tool result with %s output", (_case, output, errorText) => {
    const chunks = new UIChunkMapper().map({
      ...validEvents["tool-result"],
      output,
      isError: true,
    });
    expect(chunks.at(-1)).toEqual({
      type: "tool-output-error",
      toolCallId: "call_1",
      errorText,
      dynamic: true,
    });
  });

  it("maps finish reasons onto the SDK's vocabulary", () => {
    const chunk = new UIChunkMapper()
      .map({ type: "finish-message", messageId: "m", finishReason: "abort" })
      .at(-1);
    expect(chunk).toEqual({
      type: "finish",
      finishReason: "interrupted",
      messageMetadata: { finishReason: "abort" },
    });
  });

  describe("finish", () => {
    it("closes an open text part and adds nothing after a finished message", () => {
      const mapper = new UIChunkMapper();
      mapper.map(validEvents["text-delta"]);
      mapper.map(validEvents["finish-message"]);
      expect(mapper.finish(outcome("done"))).toEqual([]);
    });

    it("reports a stream that ended before finish-message", () => {
      const mapper = new UIChunkMapper();
      mapper.map(validEvents["text-delta"]);
      const [end, error] = mapper.finish(outcome("ended"));
      expect(end).toEqual({ type: "text-end", id: "message-text-0" });
      expect(error?.type).toBe("error");
      const problem = JSON.parse(error?.type === "error" ? error.errorText : "{}");
      expect(problem).toMatchObject({ code: "stream_interrupted", status: 502 });
    });

    it("forwards a failed outcome's problem", () => {
      const problem = { ...validProblem, code: "invalid_frame" as const };
      expect(new UIChunkMapper().finish(outcome("failed", { problem }))).toEqual([
        { type: "error", errorText: JSON.stringify(problem) },
      ]);
    });

    it("marks an aborted stream", () => {
      expect(new UIChunkMapper().finish(outcome("aborted"))).toEqual([
        { type: "abort", reason: "client disconnected" },
      ]);
    });
  });
});

describe("bridgeAgentStream — wire format", () => {
  it("produces a bit-exact AI SDK UI message stream", async () => {
    const upstream = [
      encodeSseEvent(validEvents["start-message"], 1),
      encodeSseEvent({ type: "text-delta", messageId: "msg_1", delta: "Hi" }, 2),
      encodeSseEvent(validEvents["artifact-open"], 3),
      encodeSseEvent({ ...validEvents["artifact-delta"], delta: "<div/>" }, 4),
      encodeSseEvent({ ...validEvents["artifact-close"], contentLength: 6 }, 5),
      encodeSseEvent(
        { ...validEvents["finish-message"], usage: { inputTokens: 3, outputTokens: 1 } },
        6,
      ),
      "data: [DONE]\n\n",
    ].join("");

    const response = createUIMessageStreamResponse({ stream: bridgeAgentStream(bytes(upstream)) });

    expect(await response.text()).toBe(
      [
        'data: {"type":"start","messageId":"msg_1"}',
        'data: {"type":"text-start","id":"msg_1-text-0"}',
        'data: {"type":"text-delta","id":"msg_1-text-0","delta":"Hi"}',
        'data: {"type":"text-end","id":"msg_1-text-0"}',
        'data: {"type":"data-artifact-open","data":{"messageId":"msg_1","artifactId":"art_1","revision":1,"title":"Pricing table","artifactType":"react","language":"tsx"}}',
        'data: {"type":"data-artifact-delta","data":{"messageId":"msg_1","artifactId":"art_1","revision":1,"seq":0,"delta":"<div/>"},"transient":true}',
        'data: {"type":"data-artifact-close","data":{"messageId":"msg_1","artifactId":"art_1","revision":1,"contentLength":6}}',
        'data: {"type":"finish","finishReason":"stop","messageMetadata":{"finishReason":"stop","usage":{"inputTokens":3,"outputTokens":1}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    );
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-vercel-ai-ui-message-stream": "v1",
    });
  });

  it("is reassembled by the AI SDK client into the expected message", async () => {
    const server = createMockAgentServer({
      artifactTypes: ["svg", "code"],
      toolSteps: 1,
      chunkBytes: 7,
    });
    const upstream = await server.fetch("mock://agent", {
      method: "POST",
      body: JSON.stringify(agentRequest),
    });
    if (upstream.body === null) throw new Error("no body");

    let message: StudioUIMessage | undefined;
    for await (const snapshot of readUIMessageStream<StudioUIMessage>({
      stream: bridgeAgentStream(upstream.body),
    })) {
      message = snapshot;
    }

    expect(message?.metadata).toMatchObject({ finishReason: "stop" });
    const kinds = message?.parts.map((part) => part.type);
    expect(kinds).toEqual([
      "text",
      "dynamic-tool",
      "text",
      "data-artifact-open",
      "data-artifact-close",
      "text",
      "data-artifact-open",
      "data-artifact-close",
      "text",
    ]);
    expect(kinds).not.toContain("data-artifact-delta");
    const tool = message?.parts.find((part) => part.type === "dynamic-tool");
    expect(tool).toMatchObject({ toolName: "search_docs", state: "output-available" });
    const closes = message?.parts.filter((part) => part.type === "data-artifact-close");
    expect(closes?.map((part) => part.data.contentLength)).toEqual([
      MOCK_ARTIFACTS.svg.content.length,
      MOCK_ARTIFACTS.code.content.length,
    ]);
  });
});

describe("bridgeAgentStream — failures and cancellation", () => {
  it("ends with an in-band error when the upstream breaks off", async () => {
    const server = createMockAgentServer({
      artifactTypes: [],
      toolSteps: 0,
      faults: { truncateAfter: 3 },
    });
    const upstream = await server.fetch("mock://agent", {
      method: "POST",
      body: JSON.stringify(agentRequest),
    });
    const onOutcome = vi.fn();
    const chunks = await collect(bridgeAgentStream(upstream.body ?? bytes(""), { onOutcome }));

    const last = chunks.at(-1);
    expect(last?.type).toBe("error");
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "ended" }));
  });

  it("skips malformed upstream frames and still completes", async () => {
    const server = createMockAgentServer({
      artifactTypes: [],
      toolSteps: 0,
      faults: { malformedFrameAfter: 2 },
    });
    const upstream = await server.fetch("mock://agent", {
      method: "POST",
      body: JSON.stringify(agentRequest),
    });
    const onOutcome = vi.fn();
    const chunks = await collect(bridgeAgentStream(upstream.body ?? bytes(""), { onOutcome }));
    expect(chunks.at(-1)?.type).toBe("finish");
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", parseErrors: 1 }),
    );
  });

  it("cancels the upstream when the consumer cancels", async () => {
    let cancelled: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSseEvent(validEvents["start-message"])));
      },
      cancel(reason) {
        cancelled = reason ?? "cancelled";
      },
    });
    const reader = bridgeAgentStream(upstream).getReader();
    expect((await reader.read()).value).toEqual({ type: "start", messageId: "msg_1" });
    await reader.cancel("client gone");
    await vi.waitFor(() => expect(cancelled).toBeDefined());
  });

  it("ends with an abort chunk when the caller aborts", async () => {
    const controller = new AbortController();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(encodeSseEvent(validEvents["start-message"])));
      },
    });
    const stream = bridgeAgentStream(upstream, { signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    const rest: StudioUIMessageChunk[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
    expect(rest).toEqual([{ type: "abort", reason: "client disconnected" }]);
  });

  it("honours a signal that is already aborted", async () => {
    const chunks = await collect(
      bridgeAgentStream(bytes(encodeSseEvent(validEvents["start-message"])), {
        signal: AbortSignal.abort(),
      }),
    );
    expect(chunks).toEqual([{ type: "abort", reason: "client disconnected" }]);
  });

  it("reads the upstream only as fast as the consumer pulls", async () => {
    const options = { artifactTypes: ["html", "react", "markdown"] as const, deltaChars: 4 };
    const frames = mockAgentFrames(agentRequest, options).length;
    const server = createMockAgentServer(options);
    const fetched = await server.fetch("mock://agent", {
      method: "POST",
      body: JSON.stringify(agentRequest),
    });
    let pulls = 0;
    const source = fetched.body?.getReader();
    const counted = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulls++;
          const r = await source?.read();
          if (r === undefined || r.done) controller.close();
          else controller.enqueue(r.value);
        },
      },
      { highWaterMark: 0 },
    );
    const reader = bridgeAgentStream(counted).getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toBeGreaterThan(300);
    expect(pulls).toBeLessThan(40);
    await reader.cancel();
  });
});
