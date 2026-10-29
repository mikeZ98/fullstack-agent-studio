// @vitest-environment node
// Engineering benchmarks for the streaming pipeline and the guardrails (`pnpm bench`).
// Each scenario is timed with performance.now() over several rounds after a warm-up; the
// table written to .cache/benchmarks.md is what docs/benchmarks.md reports. Timings depend on the
// machine; the assertions only guard against order-of-magnitude regressions.
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  type ArtifactStoreState,
  artifactReducer,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
} from "@/lib/core/artifact-reducer";
import { type CanvasAction, canvasReducer, INITIAL_CANVAS_MODEL } from "@/lib/core/canvas-reducer";
import { consumeEventStream } from "@/lib/core/stream-dispatcher";
import { inspectArtifactSource } from "@/lib/guardrails/artifact-guardrails";
import { assessInput } from "@/lib/guardrails/input-guardrails";
import type { StreamEvent } from "@/lib/schemas";
import {
  artifactEvents,
  chunkedBody,
  scriptedAgent,
  scriptedReply,
  seededRandom,
  sseFrames,
} from "~tests/fixtures/agent";
import { chatRequest } from "~tests/fixtures/chat";
import { routePipeline } from "~tests/fixtures/pipeline";

const ROUNDS = 7;
const rows: string[][] = [];

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

async function time(fn: () => unknown | Promise<unknown>): Promise<number[]> {
  await fn(); // warm-up
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return samples;
}

const ms = (value: number) =>
  value < 1 ? `${(value * 1000).toFixed(1)} µs` : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
const record = (scenario: string, workload: string, result: string, note = "") =>
  rows.push([scenario, workload, result, note]);

const LINE = "const value = compute(input); // payload line\n";
const SOURCE = `${LINE.repeat(Math.ceil(100_000 / LINE.length)).slice(0, 99_996)}end\n`;

// Vitest hides console output of passing tests, so the report goes to a (git-ignored) file.
const REPORT = path.resolve(import.meta.dirname, "../../.cache/benchmarks.md");

afterAll(() => {
  const header = ["Scenario", "Workload", "Result", "Notes"];
  const table = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`);
  const title = `Node ${process.version}, ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"}, median of ${ROUNDS} rounds`;
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${title}\n\n${table.join("\n")}\n`);
});

describe("streaming pipeline", () => {
  it("SSE dispatcher: parses and validates 10,000 frames split at random byte boundaries", async () => {
    const events: StreamEvent[] = [{ type: "start-message", messageId: "m" }];
    for (let i = 0; i < 9_998; i++)
      events.push({ type: "text-delta", messageId: "m", delta: `token ${i} ` });
    events.push({ type: "finish-message", messageId: "m", finishReason: "stop" });
    const bytes = new TextEncoder().encode(sseFrames(events).join(""));
    const random = seededRandom(1);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; ) {
      const size = 1 + Math.floor(random() * 4_096);
      chunks.push(bytes.slice(at, at + size));
      at += size;
    }
    const { median } = stats(
      await time(async () => {
        const outcome = await consumeEventStream(chunkedBody(chunks));
        expect(outcome.events).toBe(10_000);
      }),
    );
    record(
      "SSE dispatcher",
      `10,000 frames, ${(bytes.length / 1024).toFixed(0)} KiB, random chunks`,
      `${ms(median)} (${Math.round(10_000 / (median / 1000)).toLocaleString("en-US")} events/s)`,
      "framing + JSON + schema validation",
    );
    expect(median).toBeLessThan(5_000);
  });

  it("artifact reducer: applies a 100,000-character artifact in 1,000-character deltas", async () => {
    const events = artifactEvents("m", {
      id: "a",
      type: "code",
      title: "Big",
      content: SOURCE,
      deltaChars: 1_000,
    });
    const perDelta: number[] = [];
    const total = await time(() => {
      let state: ArtifactStoreState = INITIAL_ARTIFACT_STORE;
      for (const event of events) {
        const started = performance.now();
        state = artifactReducer(state, event);
        if (event.type === "artifact-delta") perDelta.push(performance.now() - started);
      }
      expect(selectArtifact(state, "a")?.state).toBe("complete");
    });
    const delta = stats(perDelta);
    record(
      "Artifact reducer",
      "100,000 chars in 100 in-order deltas",
      `${ms(stats(total).median)} total; per delta p50 ${ms(delta.median)}, p95 ${ms(delta.p95)}`,
      "includes sealing + content hash",
    );
    expect(delta.p95).toBeLessThan(16);
  });

  it("artifact reducer: reassembles the same artifact delivered in reverse order", async () => {
    const events = artifactEvents("m", {
      id: "a",
      type: "code",
      title: "Big",
      content: SOURCE,
      deltaChars: 1_000,
    });
    const [open, ...rest] = events;
    const close = rest.pop();
    const reversed = [open, ...rest.reverse(), close] as StreamEvent[];
    const { median } = stats(
      await time(() => {
        const state = reversed.reduce(artifactReducer, INITIAL_ARTIFACT_STORE);
        expect(selectArtifact(state, "a")?.content).toBe(SOURCE);
      }),
    );
    record(
      "Artifact reducer",
      "same, 100 deltas fully reversed",
      ms(median),
      "worst case for the reorder buffer",
    );
    expect(median).toBeLessThan(1_000);
  });

  it("end to end: /api/chat → agent client → bridge for a 100,000-character artifact", async () => {
    const turn = scriptedReply("msg_big", {
      artifacts: [
        { id: "art_big", type: "code", title: "Big", content: SOURCE, deltaChars: 1_000 },
      ],
    });
    const { median } = stats(
      await time(async () => {
        const pipeline = routePipeline({ upstream: scriptedAgent([turn]).fetch });
        const response = await pipeline.handle(
          new Request("http://studio.invalid/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(chatRequest),
          }),
        );
        const text = await response.text();
        expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
      }),
    );
    record(
      "Route pipeline",
      "100,000-char artifact, 100 deltas, through the real handler",
      `${ms(median)} (${(100_000 / 1024 / 1024 / (median / 1000)).toFixed(1)} MiB/s of artifact)`,
      "SSE in → UI message stream out",
    );
    expect(median).toBeLessThan(5_000);
  });
});

describe("guardrails", () => {
  it("artifact inspection of 100,000-character sources", async () => {
    const html =
      `<!doctype html><html><body>${"<p>Hello <b>world</b></p>\n".repeat(4_000)}</body></html>`.slice(
        0,
        100_000,
      );
    const react = `export default function A() {\n${"  const x = items.map((i) => <li key={i}>{i}</li>);\n".repeat(1_900)}  return <ul />;\n}`;
    for (const [type, language, content] of [
      ["html", "html", html],
      ["react", "tsx", react],
    ] as const) {
      const { median } = stats(
        await time(() => inspectArtifactSource({ type, language, content })),
      );
      record(
        "Artifact inspection",
        `${type}, ${(content.length / 1000).toFixed(0)}k chars`,
        ms(median),
        "static scan, no compile",
      );
      expect(median).toBeLessThan(2_000);
    }
  });

  it("input screening of a 100,000-character prompt", async () => {
    const prompt = "Please build a dashboard with charts and filters. ".repeat(2_000);
    const { median } = stats(await time(() => expect(assessInput(prompt).allowed).toBe(true)));
    record(
      "Input screening",
      "100,000-char benign prompt",
      ms(median),
      "NFKC + skeleton + all rules",
    );
    expect(median).toBeLessThan(2_000);
  });
});

describe("canvas", () => {
  it("tab management: 10,000 seeded open/select/close operations", async () => {
    const random = seededRandom(5);
    const actions: CanvasAction[] = Array.from({ length: 10_000 }, () => {
      const id = `art_${Math.floor(random() * 40)}`;
      const roll = random();
      return roll < 0.5
        ? { type: "open-tab", artifactId: id, artifactType: "html" }
        : roll < 0.8
          ? { type: "set-active-tab", artifactId: id }
          : { type: "close-tab", artifactId: id };
    });
    const { median } = stats(await time(() => actions.reduce(canvasReducer, INITIAL_CANVAS_MODEL)));
    record(
      "Canvas reducer",
      "10,000 operations, 40 artifacts, 12-tab cap",
      `${ms(median)} (${((median * 1000) / 10_000).toFixed(2)} µs/op)`,
      "LRU eviction included",
    );
    expect(median).toBeLessThan(1_000);
  });
});
