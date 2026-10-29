// High-throughput and concurrency stress: stop/re-submit storms, hundreds of concurrent
// streams with seeded abort schedules, tab capacity under churn, and 100k-character
// artifacts. Schedules come from seeded PRNGs, so every run replays the same interleaving.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readUIMessageStream } from "ai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Studio } from "@/components/studio";
import { type StudioContextValue, StudioProvider, useStudio } from "@/components/studio-provider";
import {
  type ArtifactStoreState,
  artifactReducer,
  contentHash,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
  selectArtifacts,
} from "@/lib/core/artifact-reducer";
import {
  type CanvasAction,
  type CanvasModel,
  canvasReducer,
  INITIAL_CANVAS_MODEL,
} from "@/lib/core/canvas-reducer";
import { consumeEventStream } from "@/lib/core/stream-dispatcher";
import {
  type ArtifactType,
  CanvasStateSchema,
  LIMITS,
  type StreamEvent,
  type StudioUIMessage,
} from "@/lib/schemas";
import { createAgentClient } from "@/lib/tools/agent-client";
import { createMockAgentServer, mockAgentEvents } from "@/lib/tools/mock-agent-provider";
import { bridgeAgentStream, type StudioUIMessageChunk } from "@/lib/tools/stream-bridge";
import {
  artifactEvents,
  chunkedBody,
  scriptedAgent,
  scriptedReply,
  seededRandom,
  sseFrames,
  stallUntilAborted,
  trackBodies,
} from "~tests/fixtures/agent";
import { agentRequest, chatRequest } from "~tests/fixtures/chat";
import { routePipeline } from "~tests/fixtures/pipeline";

const chat = () => screen.getByRole("region", { name: "Chat" });
const canvas = () => screen.getByRole("region", { name: "Canvas" });

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

/** Exposes the live studio context to a test, to drive useChat directly. */
const probe: { studio?: StudioContextValue } = {};
function Probe() {
  probe.studio = useStudio();
  return null;
}

/** Count listeners added to and removed from one AbortSignal. */
function listenerLedger(signal: AbortSignal) {
  const live = new Set<unknown>();
  const wrappers = new Map<unknown, unknown>();
  let added = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    added++;
    live.add(listener);
    // `once` listeners remove themselves when they fire; track that too.
    const once = typeof options === "object" && options?.once === true;
    const wrapped =
      once && typeof listener === "function"
        ? (event: Event) => {
            live.delete(listener);
            listener(event);
          }
        : listener;
    add(type, wrapped, options);
    if (wrapped !== listener) wrappers.set(listener, wrapped);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    live.delete(listener);
    remove(type, (wrappers.get(listener) ?? listener) as EventListener, options);
  });
  return { live: () => live.size, added: () => added };
}

describe("stress — rapid-fire prompts with stop and immediate re-submit", () => {
  const PROMPT = "Build a react component";
  // Stall the stream inside the artifact, so every Stop lands mid-artifact.
  const MARKER = '"seq":3,';
  const ROUNDS = 6;

  it("stalls inside the artifact for this prompt (fixture check)", () => {
    const events = mockAgentEvents(
      { chatId: "c", messages: [{ role: "user", content: `${PROMPT} 0` }] },
      { toolSteps: 0 },
    );
    expect(events.some((e) => e.type === "artifact-delta" && e.seq === 3)).toBe(true);
  });

  it("leaves no open stream or streaming artifact behind (UI)", async () => {
    const server = createMockAgentServer({ toolSteps: 0 });
    const tracked = trackBodies(stallUntilAborted(server.fetch, MARKER, ROUNDS));
    const pipeline = routePipeline({ upstream: tracked.fetch });
    const user = userEvent.setup();
    render(createElement(Studio, { transport: pipeline.transport }));
    const box = () => screen.getByRole("textbox", { name: "Message" });

    for (let round = 0; round < ROUNDS; round++) {
      await user.type(box(), `${PROMPT} ${round}{Enter}`);
      await waitFor(() =>
        expect(within(canvas()).getByLabelText("Generating")).toBeInTheDocument(),
      );
      await user.click(screen.getByRole("button", { name: "Stop generating" }));
      await screen.findByRole("button", { name: "Send message" });
    }
    await user.type(box(), `${PROMPT} final{Enter}`);
    await waitFor(() => {
      const turns = within(chat()).getAllByRole("article", { name: "Assistant" });
      expect(turns).toHaveLength(ROUNDS + 1);
      expect(turns.at(-1)).toHaveTextContent("All artifacts are ready.");
    });

    // Every stopped artifact settled as failed; only the last one is ready; none streams.
    expect(screen.queryByLabelText("Generating")).not.toBeInTheDocument();
    expect(within(chat()).getAllByText("Failed")).toHaveLength(ROUNDS);
    expect(within(chat()).getAllByText("Ready")).toHaveLength(1);

    await waitFor(() => expect(tracked.open()).toBe(0));
    expect(tracked.opened).toBe(ROUNDS + 1);
    expect(pipeline.outcomes.map((o) => o.status)).toEqual([
      ...Array(ROUNDS).fill("aborted"),
      "done",
    ]);
    expect(server.stats.requests).toHaveLength(ROUNDS + 1);
  });

  it("stop and send in the same tick: the old stream dies, the new one completes", async () => {
    const server = createMockAgentServer({ toolSteps: 0 });
    const tracked = trackBodies(stallUntilAborted(server.fetch, MARKER, 1));
    const pipeline = routePipeline({ upstream: tracked.fetch });

    render(
      createElement(StudioProvider, {
        transport: pipeline.transport,
        // biome-ignore lint/correctness/noChildrenProp: no JSX in this .ts suite, and the provider's props type requires children.
        children: createElement(Probe),
      }),
    );
    const current = () => {
      if (probe.studio === undefined) throw new Error("studio not rendered");
      return probe.studio;
    };

    act(() => void current().sendUserMessage(`${PROMPT} one`));
    await waitFor(() =>
      expect(selectArtifacts(current().artifacts).map((a) => a.state)).toEqual(["streaming"]),
    );

    // The race: stop and immediately re-submit, without waiting for the abort to settle.
    await act(async () => {
      void current().chat.stop();
      current().sendUserMessage(`${PROMPT} two`);
    });
    await waitFor(() => expect(current().chat.status).toBe("ready"));
    await waitFor(() =>
      expect(selectArtifacts(current().artifacts).map((a) => a.state)).toEqual([
        "error",
        "complete",
      ]),
    );
    expect(selectArtifacts(current().artifacts)[0]?.error?.code).toBe("stream_interrupted");
    expect(current().chat.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await waitFor(() => expect(tracked.open()).toBe(0));
    expect(server.stats.requests).toHaveLength(2);
  });
});

describe("stress — hundreds of concurrent streams with seeded aborts", () => {
  it("every stream settles and every upstream body is released (200 streams)", async () => {
    const server = createMockAgentServer({ toolSteps: 1, artifactTypes: ["html"], chunkBytes: 97 });
    const tracked = trackBodies(server.fetch);
    const pipeline = routePipeline({ upstream: tracked.fetch });
    const random = seededRandom(2_026);

    const plans = Array.from({ length: 200 }, (_, i) => {
      const roll = random();
      const plan =
        roll < 0.25 ? "abort-early" : roll < 0.5 ? "abort-mid" : roll < 0.75 ? "cancel" : "drain";
      return { i, plan, after: 1 + Math.floor(random() * 6) };
    });

    const results = await Promise.all(
      plans.map(async ({ i, plan, after }) => {
        const controller = new AbortController();
        if (plan === "abort-early") controller.abort();
        const response = await pipeline.handle(
          new Request("http://studio.invalid/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...chatRequest, id: `chat_${i}` }),
            signal: controller.signal,
          }),
        );
        if (response.body === null) return { plan, status: response.status, chunks: 0 };
        const reader = response.body.getReader();
        let chunks = 0;
        for (;;) {
          if (plan !== "drain" && chunks === after) {
            if (plan === "abort-mid") controller.abort();
            else await reader.cancel();
          }
          const r = await reader.read().catch(() => ({ done: true as const }));
          if (r.done) break;
          chunks++;
        }
        return { plan, status: response.status, chunks };
      }),
    );

    expect(results.filter((r) => r.plan === "abort-early").every((r) => r.status === 499)).toBe(
      true,
    );
    expect(results.filter((r) => r.plan !== "abort-early").every((r) => r.status === 200)).toBe(
      true,
    );
    await vi.waitFor(() => expect(tracked.open()).toBe(0));
    const streamed = plans.filter((p) => p.plan !== "abort-early").length;
    expect(tracked.opened).toBe(streamed);
    expect(pipeline.outcomes).toHaveLength(streamed);
    const drained = plans.filter((p) => p.plan === "drain").length;
    expect(pipeline.outcomes.filter((o) => o.status === "done")).toHaveLength(drained);
  });

  it("agent client and bridge add and remove signal listeners in balance", async () => {
    const server = createMockAgentServer({ toolSteps: 0, artifactTypes: ["svg"] });
    const client = createAgentClient({ endpoint: "http://agent.invalid", fetch: server.fetch });
    const shared = new AbortController();
    const ledger = listenerLedger(shared.signal);
    const random = seededRandom(7);

    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const upstream = await client.stream(agentRequest, { signal: shared.signal });
        const ui = bridgeAgentStream(upstream, { signal: shared.signal });
        const reader = ui.getReader();
        const stopAfter = random() < 0.5 ? Math.floor(random() * 8) : Number.POSITIVE_INFINITY;
        for (let n = 0; ; n++) {
          if (n === stopAfter) {
            await reader.cancel();
            break;
          }
          if ((await reader.read()).done) break;
        }
      }),
    );

    expect(ledger.added()).toBeGreaterThanOrEqual(400);
    await vi.waitFor(() => expect(ledger.live()).toBe(0));
    expect(shared.signal.aborted).toBe(false);
  });

  it("dispatcher outcomes are exact under a seeded abort schedule (500 streams)", async () => {
    const frames = sseFrames(
      scriptedReply("msg_s", {
        artifacts: [
          { id: "a", type: "code", title: "c", content: "y".repeat(2_000), deltaChars: 100 },
        ],
      }),
    );
    const random = seededRandom(99);
    const runs = await Promise.all(
      Array.from({ length: 500 }, async () => {
        const controller = new AbortController();
        const abortAt = random() < 0.5 ? Math.floor(random() * frames.length) : -1;
        let seen = 0;
        const outcome = await consumeEventStream(chunkedBody(frames), {
          signal: controller.signal,
          handlers: {
            onEvent: () => {
              if (++seen === abortAt) controller.abort();
            },
          },
        });
        return { abortAt, outcome, seen };
      }),
    );
    for (const { abortAt, outcome, seen } of runs) {
      if (abortAt > 0) {
        expect(outcome.status).toBe("aborted");
        expect(seen).toBe(abortAt);
      } else {
        expect(outcome.status).toBe("done");
        expect(outcome.events).toBe(frames.length - 1);
      }
    }
  });
});

describe("stress — tab capacity and LRU eviction", () => {
  const TYPES: ArtifactType[] = ["html", "react", "markdown", "svg", "mermaid", "code"];
  const id = (n: number) => `art_${String(n).padStart(3, "0")}`;
  const openTab = (n: number, activate = true): CanvasAction => ({
    type: "open-tab",
    artifactId: id(n),
    artifactType: TYPES[n % TYPES.length] ?? "html",
    activate,
  });

  function checkInvariants(model: CanvasModel) {
    const { tabs, activeArtifactId } = model.canvas;
    const ids = tabs.map((t) => t.artifactId);
    expect(tabs.length).toBeLessThanOrEqual(LIMITS.canvasTabs);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...model.recency].sort()).toEqual([...ids].sort());
    if (activeArtifactId === null) expect(tabs).toHaveLength(0);
    else expect(ids).toContain(activeArtifactId);
    expect(CanvasStateSchema.safeParse(model.canvas).success).toBe(true);
  }

  it("evicts exactly the least recently used tabs, never the active one", () => {
    let model = INITIAL_CANVAS_MODEL;
    for (let n = 0; n < LIMITS.canvasTabs; n++) model = canvasReducer(model, openTab(n));
    // Use tab 0 and 1 again: they become the most recent, so 2, 3, 4 go first.
    model = canvasReducer(model, { type: "set-active-tab", artifactId: id(0) });
    model = canvasReducer(model, { type: "set-active-tab", artifactId: id(1) });
    for (let n = LIMITS.canvasTabs; n < LIMITS.canvasTabs + 3; n++)
      model = canvasReducer(model, openTab(n));

    const ids = model.canvas.tabs.map((t) => t.artifactId);
    expect(ids).toHaveLength(LIMITS.canvasTabs);
    expect(ids).not.toEqual(expect.arrayContaining([id(2), id(3), id(4)]));
    expect(ids).toEqual(expect.arrayContaining([id(0), id(1)]));
    expect(model.canvas.activeArtifactId).toBe(id(LIMITS.canvasTabs + 2));

    // Background opens never steal focus and never evict the active tab.
    const active = model.canvas.activeArtifactId;
    for (let n = 100; n < 100 + LIMITS.canvasTabs * 2; n++)
      model = canvasReducer(model, openTab(n, false));
    expect(model.canvas.activeArtifactId).toBe(active);
    expect(model.canvas.tabs.map((t) => t.artifactId)).toContain(active);
    checkInvariants(model);
  });

  it("holds every invariant through 5,000 seeded random operations, deterministically", () => {
    function churn(seed: number): CanvasModel {
      const random = seededRandom(seed);
      let model = INITIAL_CANVAS_MODEL;
      for (let step = 0; step < 5_000; step++) {
        const n = Math.floor(random() * 40);
        const roll = random();
        const action: CanvasAction =
          roll < 0.45
            ? openTab(n, random() < 0.7)
            : roll < 0.7
              ? { type: "set-active-tab", artifactId: id(n) }
              : roll < 0.9
                ? { type: "close-tab", artifactId: id(n) }
                : {
                    type: "pin-revision",
                    artifactId: id(n),
                    revision: 1 + Math.floor(random() * 3),
                  };
        const before = model;
        model = canvasReducer(model, action);
        if (action.type === "open-tab" && action.activate !== false)
          expect(model.canvas.activeArtifactId).toBe(action.artifactId);
        if (action.type === "open-tab" && model.canvas.tabs.length === LIMITS.canvasTabs) {
          const evicted = before.canvas.tabs
            .map((t) => t.artifactId)
            .filter((x) => !model.canvas.tabs.some((t) => t.artifactId === x));
          // At most one tab per open, and it was the least recently used candidate.
          expect(evicted.length).toBeLessThanOrEqual(1);
          if (evicted[0] !== undefined) {
            const candidates = before.recency.filter(
              (x) => x !== action.artifactId && x !== model.canvas.activeArtifactId,
            );
            expect(evicted[0]).toBe(candidates.at(-1));
          }
        }
        checkInvariants(model);
      }
      return model;
    }
    expect(churn(12)).toEqual(churn(12));
    expect(churn(12)).not.toEqual(churn(13));
  });

  it("UI: one reply with 15 artifacts docks 12 tabs and focuses the newest", async () => {
    const count = LIMITS.canvasTabs + 3;
    const artifacts = Array.from({ length: count }, (_, n) => ({
      id: id(n),
      type: "markdown" as const,
      title: `Doc ${n}`,
      content: `# Doc ${n}`,
    }));
    const pipeline = routePipeline({
      upstream: scriptedAgent([scriptedReply("msg_many", { artifacts })]).fetch,
    });
    const user = userEvent.setup();
    render(createElement(Studio, { transport: pipeline.transport }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Write fifteen docs{Enter}");
    await waitFor(() => expect(within(chat()).getAllByText("Ready")).toHaveLength(count));

    const tablist = () => screen.getByRole("tablist", { name: "Open artifacts" });
    const titles = () =>
      within(tablist())
        .getAllByRole("tab")
        .map((t) => t.textContent);
    expect(titles()).toEqual(Array.from({ length: LIMITS.canvasTabs }, (_, n) => `Doc ${n + 3}`));
    expect(within(tablist()).getByRole("tab", { selected: true })).toHaveTextContent(
      `Doc ${count - 1}`,
    );

    // Re-opening an evicted artifact from chat evicts the next LRU tab instead.
    await user.click(within(chat()).getByRole("button", { name: "Open Doc 0 in canvas" }));
    expect(titles()).toHaveLength(LIMITS.canvasTabs);
    expect(titles()).not.toContain("Doc 3");
    expect(titles().at(-1)).toBe("Doc 0");
    expect(within(tablist()).getByRole("tab", { selected: true })).toHaveTextContent("Doc 0");
  });
});

describe("stress — 100,000-character artifacts", () => {
  const SIZE = 100_000;
  const LINE = "const value = compute(input); // payload line\n";
  const source = `${LINE.repeat(Math.ceil(SIZE / LINE.length)).slice(0, SIZE - 4)}end\n`;

  function percentile(samples: number[], p: number) {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  }

  it.each([
    ["1,000-character deltas", 1_000],
    ["maximum-size deltas", LIMITS.deltaChars],
  ])("streams through route and bridge with %s, intact and bounded", async (_name, deltaChars) => {
    const turn = scriptedReply("msg_big", {
      artifacts: [{ id: "art_big", type: "code", title: "Big", content: source, deltaChars }],
    });
    const pipeline = routePipeline({ upstream: scriptedAgent([turn]).fetch });
    const response = await pipeline.handle(
      new Request("http://studio.invalid/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatRequest),
      }),
    );
    const body = (response.body ?? new ReadableStream()).pipeThrough(new TextDecoderStream());

    // Decode the UI stream, apply every artifact chunk to the store, and time each apply.
    const timings: number[] = [];
    let store: ArtifactStoreState = INITIAL_ARTIFACT_STORE;
    let buffer = "";
    const chunks = new ReadableStream<StudioUIMessageChunk>({
      async start(controller) {
        const reader = body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const text = r.value;
          buffer += text;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.startsWith("data: {")) continue;
            const chunk = JSON.parse(frame.slice(6)) as StudioUIMessageChunk;
            if (chunk.type.startsWith("data-artifact-")) {
              const kind = chunk.type.slice("data-".length) as StreamEvent["type"];
              const data = (chunk as { data: object }).data;
              const started = performance.now();
              store = artifactReducer(store, { type: kind, ...data } as StreamEvent);
              timings.push(performance.now() - started);
            }
            controller.enqueue(chunk);
          }
        }
        controller.close();
      },
    });
    let message: StudioUIMessage | undefined;
    for await (const snapshot of readUIMessageStream<StudioUIMessage>({ stream: chunks }))
      message = snapshot;

    const record = selectArtifact(store, "art_big");
    expect(record).toMatchObject({ state: "complete", truncated: false, pending: [] });
    expect(record?.content).toHaveLength(SIZE);
    expect(record?.history[0]?.hash).toBe(contentHash(source));
    // Deltas are transient: the 100k payload lives in the store, not in chat history.
    expect(JSON.stringify(message).length).toBeLessThan(2_000);
    // Each store update fits comfortably inside one 60 fps frame.
    expect(percentile(timings, 0.95)).toBeLessThan(16);
    expect(pipeline.outcomes[0]?.status).toBe("done");
  });

  it("caps an oversized artifact at LIMITS.artifactContentChars", () => {
    const huge = "z".repeat(LIMITS.artifactContentChars + 50_000);
    const events = artifactEvents("msg_huge", {
      id: "art_huge",
      type: "code",
      title: "Huge",
      content: huge,
      deltaChars: LIMITS.deltaChars,
    }).filter((e) => e.type !== "artifact-close");
    const state = events.reduce(artifactReducer, INITIAL_ARTIFACT_STORE);
    const record = selectArtifact(state, "art_huge");
    expect(record?.content).toHaveLength(LIMITS.artifactContentChars);
    expect(record?.truncated).toBe(true);
  });

  it("UI: renders a 100k-character artifact and stays interactive", async () => {
    const turn = scriptedReply("msg_big", {
      artifacts: [
        { id: "art_big", type: "code", title: "Big file", content: source, deltaChars: 25_000 },
      ],
    });
    const pipeline = routePipeline({ upstream: scriptedAgent([turn]).fetch });
    const user = userEvent.setup();
    render(createElement(Studio, { transport: pipeline.transport }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Write a big file{Enter}");
    const card = await within(chat()).findByRole("button", { name: "Open Big file in canvas" });
    await waitFor(() => expect(within(card).getByText("Ready")).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // Every line of the source is rendered, through to the last one.
    const code = within(canvas()).getByRole("tabpanel").querySelector("pre code");
    const lines = [...(code?.children ?? [])];
    expect(lines).toHaveLength(source.split("\n").length);
    expect(lines.at(-2)?.textContent).toMatch(/end$/);

    // Still responsive afterwards: the composer accepts the next prompt.
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.type(box, "thanks");
    expect(box).toHaveValue("thanks");
  }, 20_000);
});
