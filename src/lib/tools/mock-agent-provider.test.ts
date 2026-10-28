// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  artifactReducer,
  INITIAL_ARTIFACT_STORE,
  selectArtifacts,
} from "@/lib/core/artifact-reducer";
import { preprocessArtifact } from "@/lib/core/sandbox-preprocessor";
import { consumeEventStream } from "@/lib/core/stream-dispatcher";
import {
  type AgentRequest,
  ArtifactTypeSchema,
  type StreamEvent,
  StreamEventSchema,
} from "@/lib/schemas";
import { agentRequest, readText } from "~tests/fixtures/chat";

import {
  createMockAgentServer,
  encodeSseEvent,
  inferArtifactTypes,
  MOCK_ARTIFACTS,
  type MockAgentOptions,
  mockAgentEvents,
  mockAgentFrames,
} from "./mock-agent-provider";

const ALL_TYPES = ArtifactTypeSchema.options;

async function respond(
  options: MockAgentOptions,
  request: AgentRequest = agentRequest,
  init: RequestInit = {},
) {
  const server = createMockAgentServer(options);
  const response = await server.fetch("mock://agent", {
    method: "POST",
    body: JSON.stringify(request),
    ...init,
  });
  return { server, response };
}

/** Run a response body through the real dispatcher and artifact reducer. */
async function replay(body: ReadableStream<Uint8Array> | null) {
  const events: StreamEvent[] = [];
  const outcome = await consumeEventStream(body ?? new ReadableStream(), {
    handlers: { onEvent: (event) => void events.push(event) },
  });
  const store = events.reduce(artifactReducer, INITIAL_ARTIFACT_STORE);
  return { events, outcome, artifacts: selectArtifacts(store), store };
}

describe("mockAgentEvents", () => {
  it("is deterministic for the same request", () => {
    expect(mockAgentFrames(agentRequest)).toEqual(mockAgentFrames(agentRequest));
  });

  it("derives ids from the conversation", () => {
    const [first] = mockAgentEvents(agentRequest);
    const [other] = mockAgentEvents({ ...agentRequest, chatId: "chat_2" });
    expect(first).toMatchObject({
      type: "start-message",
      messageId: expect.stringMatching(/^msg_[0-9a-f]{8}$/),
    });
    expect(other).not.toEqual(first);
  });

  it("emits only schema-valid protocol events", () => {
    for (const event of mockAgentEvents(agentRequest, { artifactTypes: ALL_TYPES, toolSteps: 3 })) {
      expect(StreamEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it("simulates multi-step tool use", () => {
    const events = mockAgentEvents(agentRequest, { toolSteps: 3, artifactTypes: [] });
    const tools = events.filter((e) => e.type === "tool-call" || e.type === "tool-result");
    expect(tools.map((e) => [e.type, "toolName" in e ? e.toolName : ""])).toEqual([
      ["tool-call", "search_docs"],
      ["tool-result", "search_docs"],
      ["tool-call", "run_analysis"],
      ["tool-result", "run_analysis"],
      ["tool-call", "search_docs"],
      ["tool-result", "search_docs"],
    ]);
  });

  it("starts with start-message and ends with finish-message", () => {
    const events = mockAgentEvents(agentRequest);
    expect(events[0]?.type).toBe("start-message");
    expect(events.at(-1)).toMatchObject({ type: "finish-message", finishReason: "stop" });
  });

  it("truncates long prompts in its reply", () => {
    const long = {
      ...agentRequest,
      messages: [{ role: "user" as const, content: "x".repeat(100) }],
    };
    const text = mockAgentEvents(long, { toolSteps: 0 })
      .flatMap((e) => (e.type === "text-delta" ? [e.delta] : []))
      .join("");
    expect(text).toContain(`"${"x".repeat(57)}..."`);
  });

  it.each([
    ["Make an HTML landing page", ["html"]],
    ["Draw an SVG logo and a flow chart", ["svg", "mermaid"]],
    ["A React component", ["react"]],
    ["Write release notes in markdown", ["markdown"]],
    ["Python script please", ["code"]],
    ["Just say hello", []],
  ])("infers artifact types from %j", (prompt, types) => {
    expect(inferArtifactTypes(prompt)).toEqual(types);
  });

  it("emits no artifacts when none are requested", () => {
    const events = mockAgentEvents({ chatId: "c", messages: [{ role: "user", content: "hello" }] });
    expect(events.some((e) => e.type === "artifact-open")).toBe(false);
  });
});

describe("artifact lifecycles", () => {
  it.each(ALL_TYPES)("streams a complete, runnable %s artifact", async (type) => {
    const { response } = await respond({ artifactTypes: [type], deltaChars: 16, chunkBytes: 5 });
    const { artifacts, outcome, store } = await replay(response.body);

    expect(outcome).toMatchObject({ status: "done", parseErrors: 0 });
    expect(store.diagnostics).toEqual([]);
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact).toMatchObject({
      type,
      state: "complete",
      content: MOCK_ARTIFACTS[type].content,
    });

    const prepared = preprocessArtifact(
      { type, language: MOCK_ARTIFACTS[type].language, content: MOCK_ARTIFACTS[type].content },
      { nonce: "fixed-nonce-0123456789" },
    );
    expect(prepared.blockers).toEqual([]);
  });

  it("emits several artifacts in one message", async () => {
    const { response } = await respond({ artifactTypes: ALL_TYPES });
    const { artifacts } = await replay(response.body);
    expect(artifacts.map((a) => [a.type, a.state])).toEqual(ALL_TYPES.map((t) => [t, "complete"]));
  });
});

describe("fault injection", () => {
  it("drops deltas so the artifact fails its integrity checks", async () => {
    const { response } = await respond({ artifactTypes: ["html"], faults: { dropDeltaSeqs: [1] } });
    const { artifacts, store } = await replay(response.body);
    expect(artifacts[0]?.state).toBe("error");
    expect(store.diagnostics.map((d) => d.code)).toContain("missing-deltas");
  });

  it("reorders deltas without losing content", async () => {
    const { response } = await respond({
      artifactTypes: ["react"],
      faults: { reorderDeltas: true },
    });
    const { artifacts, events } = await replay(response.body);
    const seqs = events.flatMap((e) => (e.type === "artifact-delta" ? [e.seq] : []));
    expect(seqs[0]).toBeGreaterThan(seqs.at(-1) ?? 0);
    expect(artifacts[0]).toMatchObject({
      state: "complete",
      content: MOCK_ARTIFACTS.react.content,
    });
  });

  it("injects a malformed JSON frame", async () => {
    const { response } = await respond({ artifactTypes: [], faults: { malformedFrameAfter: 1 } });
    const { outcome } = await replay(response.body);
    expect(outcome).toMatchObject({ status: "done", parseErrors: 1 });
  });

  it("truncates the stream without finish or [DONE]", async () => {
    const { response } = await respond({ artifactTypes: [], faults: { truncateAfter: 2 } });
    const text = await readText(response.body);
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("finish-message");
  });

  it("answers with an injected status, Retry-After and recovery", async () => {
    const server = createMockAgentServer({
      faults: { httpStatus: 429, failAttempts: 1, retryAfterSeconds: 7 },
    });
    const init = { method: "POST", body: JSON.stringify(agentRequest) };
    const first = await server.fetch("mock://agent", init);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("7");
    expect(await first.text()).toBe("mock agent error 429");
    const second = await server.fetch("mock://agent", init);
    expect(second.status).toBe(200);
    expect(server.stats).toMatchObject({ failed: 1 });
  });

  it("can send the error as RFC 9457 JSON", async () => {
    const { response } = await respond({ faults: { httpStatus: 503, problemBody: true } });
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 503, detail: "Mock agent injected 503" });
  });

  it("rejects requests that violate the agent protocol", async () => {
    const server = createMockAgentServer();
    const response = await server.fetch("mock://agent", {
      method: "POST",
      body: '{"chatId":"c","messages":[]}',
    });
    expect(response.status).toBe(400);
    expect(server.stats.requests).toEqual([]);
  });
});

describe("transport behaviour", () => {
  it("encodes frames in the agent wire format", () => {
    expect(encodeSseEvent({ type: "start-message", messageId: "m" }, 4)).toBe(
      'id: 4\nevent: start-message\ndata: {"type":"start-message","messageId":"m"}\n\n',
    );
    expect(encodeSseEvent({ type: "start-message", messageId: "m" })).toBe(
      'event: start-message\ndata: {"type":"start-message","messageId":"m"}\n\n',
    );
  });

  it("splits the body into chunks of the configured size", async () => {
    const { response } = await respond({ artifactTypes: [], chunkBytes: 3 });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(first?.value?.byteLength).toBe(3);
    await reader?.cancel();
  });

  it("delays frames when configured", async () => {
    const { response } = await respond({ artifactTypes: [], toolSteps: 0, frameDelayMs: 5 });
    const started = performance.now();
    await readText(response.body);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("rejects an already-aborted request", async () => {
    await expect(
      respond({}, agentRequest, { signal: AbortSignal.abort(new Error("gone")) }),
    ).rejects.toThrow("gone");
  });

  it("errors the body when the request is aborted mid-stream", async () => {
    const controller = new AbortController();
    const { server, response } = await respond({ frameDelayMs: 50 }, agentRequest, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    const pending = reader?.read();
    controller.abort(new Error("client left"));
    await expect(pending).rejects.toThrow("client left");
    expect(server.stats.aborted).toBe(1);
  });

  it("counts consumer cancellation, including during a stall", async () => {
    const { server, response } = await respond({ artifactTypes: [], faults: { stallAfter: 1 } });
    const reader = response.body?.getReader();
    await reader?.read();
    const stalled = reader?.read();
    await reader?.cancel();
    await expect(stalled).resolves.toMatchObject({ done: true });
    expect(server.stats.cancelled).toBe(1);
  });
});
