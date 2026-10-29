// Scripted agent backends and network fault injectors for the master suites. Every helper
// here is a fetch-compatible function that serves bytes from memory: nothing opens a socket.
import {
  type AgentRequest,
  AgentRequestSchema,
  type ArtifactType,
  type StreamEvent,
} from "@/lib/schemas";
import { encodeSseEvent } from "@/lib/tools/mock-agent-provider";

export const DONE_FRAME = "data: [DONE]\n\n";
const encoder = new TextEncoder();

export interface ScriptedArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  revision?: number;
  /** Characters per delta (default 64). */
  deltaChars?: number;
}

const DEFAULT_LANGUAGE: Readonly<Record<ArtifactType, string>> = {
  html: "html",
  svg: "svg",
  react: "tsx",
  markdown: "markdown",
  mermaid: "mermaid",
  code: "ts",
};

/** open → deltas → close for one artifact revision. */
export function artifactEvents(messageId: string, artifact: ScriptedArtifact): StreamEvent[] {
  const { id: artifactId, type, title, content, revision = 1, deltaChars = 64 } = artifact;
  const language = artifact.language ?? DEFAULT_LANGUAGE[type];
  const events: StreamEvent[] = [
    { type: "artifact-open", messageId, artifactId, revision, title, artifactType: type, language },
  ];
  for (let seq = 0, at = 0; at < content.length; seq++, at += deltaChars) {
    const delta = content.slice(at, at + deltaChars);
    events.push({ type: "artifact-delta", messageId, artifactId, revision, seq, delta });
  }
  events.push({
    type: "artifact-close",
    messageId,
    artifactId,
    revision,
    contentLength: content.length,
  });
  return events;
}

/** A complete assistant turn: text, then each artifact, then finish-message. */
export function scriptedReply(
  messageId: string,
  { text = "Here you go.", artifacts = [] }: { text?: string; artifacts?: ScriptedArtifact[] } = {},
): StreamEvent[] {
  return [
    { type: "start-message", messageId },
    { type: "text-delta", messageId, delta: text },
    ...artifacts.flatMap((artifact) => artifactEvents(messageId, artifact)),
    { type: "finish-message", messageId, finishReason: "stop" },
  ];
}

/** Encode events as agent SSE frames with sequential ids, terminated by [DONE]. */
export function sseFrames(events: readonly StreamEvent[]): string[] {
  return [...events.map((event, index) => encodeSseEvent(event, index + 1)), DONE_FRAME];
}

/** A one-shot body that emits each chunk on its own read, and stops on cancel. */
export function chunkedBody(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

export function sseResponse(chunks: readonly (string | Uint8Array)[]): Response {
  return new Response(chunkedBody(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

export interface ScriptedAgent {
  fetch: typeof fetch;
  requests: AgentRequest[];
}

type Script =
  | readonly (readonly StreamEvent[])[]
  | ((request: AgentRequest, index: number) => readonly StreamEvent[]);

/**
 * An agent backend that answers request `n` with turn `n` of the script (the last turn
 * repeats once the script runs out), or with whatever a script function returns.
 */
export function scriptedAgent(script: Script): ScriptedAgent {
  const requests: AgentRequest[] = [];
  const fetch = async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const request = AgentRequestSchema.parse(JSON.parse(String(init.body)));
    const index = requests.push(request) - 1;
    const events =
      typeof script === "function" ? script(request, index) : (script[index] ?? script.at(-1));
    return sseResponse(sseFrames(events ?? []));
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** The error undici raises when the peer resets the TCP connection mid-body. */
export function socketHangUp(): TypeError {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return new TypeError("terminated", { cause });
}

/**
 * Kill the connection mid-body, the way a dropped socket does: after `at` bytes, or halfway
 * through the first chunk containing the text `at`. Bytes before the cut are delivered
 * (usually mid-frame), then the body errors. Only the first `times` responses are cut.
 */
export function dropConnection(
  upstream: typeof fetch,
  at: number | string,
  { times = Number.POSITIVE_INFINITY }: { times?: number } = {},
): typeof fetch {
  const decoder = new TextDecoder();
  let cuts = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(input, init);
    if (response.body === null || cuts >= times) return response;
    cuts++;
    const reader = response.body.getReader();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          const room =
            typeof at === "number"
              ? at - sent
              : decoder.decode(value).includes(at)
                ? Math.floor(value.byteLength / 2)
                : Number.POSITIVE_INFINITY;
          if (value.byteLength < room) {
            sent += value.byteLength;
            controller.enqueue(value);
            return;
          }
          if (room > 0) controller.enqueue(value.slice(0, room));
          await reader.cancel(socketHangUp());
          controller.error(socketHangUp());
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

export interface Gate {
  /** Resolves once a body has reached the gate and is being held. */
  reached: Promise<void>;
  release: () => void;
}

/**
 * Hold each response body just before the first chunk whose text contains `marker`, until
 * the returned gate is released: freezes the pipeline at an exact point mid-stream.
 */
export function holdAt(upstream: typeof fetch, marker: string): { fetch: typeof fetch } & Gate {
  const decoder = new TextDecoder();
  const opened = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(input, init);
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let waited = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (!waited && decoder.decode(value).includes(marker)) {
            waited = true;
            reached.resolve();
            await opened.promise;
          }
          controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof globalThis.fetch;
  return { fetch, reached: reached.promise, release: () => opened.resolve() };
}

/**
 * For the first `times` responses, stop sending just before the first chunk containing
 * `marker` and stay silent until the request is aborted (a user pressing Stop).
 */
export function stallUntilAborted(
  upstream: typeof fetch,
  marker: string,
  times: number,
): typeof fetch {
  const decoder = new TextDecoder();
  let stalls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(input, init);
    if (response.body === null || stalls >= times) return response;
    stalls++;
    const signal = init?.signal;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (decoder.decode(value).includes(marker)) {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            await reader.cancel(signal?.reason);
            controller.error(signal?.reason);
            return;
          }
          controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

export interface BodyTracker {
  fetch: typeof fetch;
  /** Bodies handed out that have not yet ended, errored or been cancelled. */
  open(): number;
  opened: number;
  /** How each body settled. */
  settled: { done: number; cancelled: number; errored: number };
}

/** Count upstream response bodies, so a test can prove none is left dangling. */
export function trackBodies(upstream: typeof fetch): BodyTracker {
  const tracker: BodyTracker = {
    fetch: undefined as unknown as typeof fetch,
    open: () =>
      tracker.opened - tracker.settled.done - tracker.settled.cancelled - tracker.settled.errored,
    opened: 0,
    settled: { done: 0, cancelled: 0, errored: 0 },
  };
  tracker.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(input, init);
    if (response.body === null) return response;
    tracker.opened++;
    const reader = response.body.getReader();
    let settled = false;
    const settle = (how: keyof BodyTracker["settled"]) => {
      if (settled) return;
      settled = true;
      tracker.settled[how]++;
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              settle("done");
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            settle("errored");
            controller.error(error);
          }
        },
        async cancel(reason) {
          settle("cancelled");
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  return tracker;
}

/** Small deterministic PRNG (mulberry32) for seeded stress and chaos schedules. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
