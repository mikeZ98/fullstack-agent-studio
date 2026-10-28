import { contentHash } from "@/lib/core/artifact-reducer";
import {
  type AgentRequest,
  AgentRequestSchema,
  type ArtifactType,
  createProblem,
  type ProblemDetails,
  type StreamEvent,
} from "@/lib/schemas";

/**
 * Deterministic in-memory stand-in for the agent backend, for tests and offline
 * development (AGENT_PROVIDER=mock). The same request and options always produce the same
 * bytes. It speaks the real wire protocol, so it plugs into `createAgentClient` as `fetch`
 * and exercises the whole pipeline, including injected faults.
 */

export interface MockArtifact {
  title: string;
  language: string;
  content: string;
}

export const MOCK_ARTIFACTS: Readonly<Record<ArtifactType, MockArtifact>> = {
  html: {
    title: "Counter page",
    language: "html",
    content: `<!doctype html>
<html lang="en">
<head><title>Counter</title><style>body { font: 16px system-ui; padding: 2rem; }</style></head>
<body>
  <h1>Clicks: <span id="count">0</span></h1>
  <button id="inc">Increment</button>
  <script>
    let count = 0;
    document.getElementById("inc").addEventListener("click", () => {
      document.getElementById("count").textContent = String(++count);
    });
  </script>
</body>
</html>`,
  },
  svg: {
    title: "Status badge",
    language: "svg",
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40">
  <title>Status badge</title>
  <rect width="120" height="40" rx="8" fill="#16a34a"/>
  <text x="60" y="25" text-anchor="middle" fill="#fff" font-family="system-ui">passing</text>
</svg>`,
  },
  react: {
    title: "Todo list",
    language: "tsx",
    content: `import { useState } from "react";
import { Check } from "lucide-react";

export default function TodoList() {
  const [items, setItems] = useState<string[]>(["Ship the studio"]);
  const [draft, setDraft] = useState("");
  return (
    <div className="p-4">
      <ul>
        {items.map((item) => (
          <li key={item}><Check size={14} /> {item}</li>
        ))}
      </ul>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { setItems([...items, draft]); setDraft(""); }}>Add</button>
    </div>
  );
}`,
  },
  markdown: {
    title: "Release notes",
    language: "markdown",
    content: `# Release notes

## Added
- Split-pane studio with streaming chat
- Live artifact canvas

## Fixed
- Reconnects after network drops`,
  },
  mermaid: {
    title: "Request flow",
    language: "mermaid",
    content: `flowchart LR
  Browser -->|POST /api/chat| Gateway
  Gateway -->|SSE| Agent
  Agent -->|artifact events| Gateway
  Gateway -->|UI message stream| Browser`,
  },
  code: {
    title: "Fibonacci",
    language: "py",
    content: `def fibonacci(n: int) -> list[int]:
    """Return the first n Fibonacci numbers."""
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]


print(fibonacci(10))`,
  },
};

const KEYWORDS: readonly [ArtifactType, RegExp][] = [
  ["html", /\b(html|web ?page|landing|website)\b/],
  ["svg", /\b(svg|icon|logo|badge)\b/],
  ["react", /\b(react|component|tsx)\b/],
  ["markdown", /\b(markdown|readme|notes|document)\b/],
  ["mermaid", /\b(mermaid|diagram|flow ?chart)\b/],
  ["code", /\b(code|python|script|function)\b/],
];

/** Artifact types a prompt asks for, in a stable order. */
export function inferArtifactTypes(prompt: string): ArtifactType[] {
  const text = prompt.toLowerCase();
  return KEYWORDS.filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
}

export interface MockFaults {
  /** Answer with this status instead of a stream... */
  httpStatus?: 400 | 401 | 404 | 429 | 500 | 502 | 503 | 504;
  /** ...for this many requests, then recover (default: every request). */
  failAttempts?: number;
  retryAfterSeconds?: number;
  /** Send an RFC 9457 body with the error status. */
  problemBody?: boolean;
  /** Insert a frame with broken JSON after this many events. */
  malformedFrameAfter?: number;
  /** Drop artifact deltas with these `seq` values (lost packets). */
  dropDeltaSeqs?: readonly number[];
  /** Send each artifact's deltas in reverse order. */
  reorderDeltas?: boolean;
  /** End the body abruptly after this many events: no finish-message, no [DONE]. */
  truncateAfter?: number;
  /** Stop sending, but keep the connection open, after this many events. */
  stallAfter?: number;
}

export interface MockAgentOptions {
  /** Artifacts to emit; inferred from the last user message when omitted. */
  artifactTypes?: readonly ArtifactType[];
  /** Replace the built-in sample for a type (e.g. with deliberately unsafe code). */
  artifacts?: Partial<Record<ArtifactType, MockArtifact>>;
  /** Tool call/result round trips before answering. */
  toolSteps?: number;
  /** Characters per artifact delta. */
  deltaChars?: number;
  /** Split the body into chunks of this many bytes (exercises reassembly). */
  chunkBytes?: number;
  /** Pause between frames, for a realistic feel in development. */
  frameDelayMs?: number;
  faults?: MockFaults;
}

const TOOLS = ["search_docs", "run_analysis"] as const;

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** The deterministic event sequence the mock agent answers `request` with. */
export function mockAgentEvents(
  request: AgentRequest,
  options: MockAgentOptions = {},
): StreamEvent[] {
  const prompt = request.messages.findLast((m) => m.role === "user")?.content ?? "";
  const seed = contentHash(`${request.chatId}:${request.messages.length}:${prompt}`);
  const messageId = `msg_${seed}`;
  const types = options.artifactTypes ?? inferArtifactTypes(prompt);
  const toolSteps = options.toolSteps ?? 1;
  const deltaChars = options.deltaChars ?? 48;

  const events: StreamEvent[] = [{ type: "start-message", messageId }];
  const say = (text: string) => {
    for (const delta of words(text)) events.push({ type: "text-delta", messageId, delta });
  };

  const excerpt = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  say(`Working on: "${excerpt}". `);

  for (let step = 0; step < toolSteps; step++) {
    const toolName = TOOLS[step % TOOLS.length] ?? "search_docs";
    const toolCallId = `call_${seed}_${step}`;
    events.push({
      type: "tool-call",
      messageId,
      toolCallId,
      toolName,
      input: { query: excerpt, step },
    });
    events.push({
      type: "tool-result",
      messageId,
      toolCallId,
      toolName,
      output: { step, summary: `${toolName} finished step ${step + 1}` },
    });
    say(`Step ${step + 1} done. `);
  }

  types.forEach((artifactType, index) => {
    const { title, language, content } =
      options.artifacts?.[artifactType] ?? MOCK_ARTIFACTS[artifactType];
    const artifactId = `art_${seed}_${index}`;
    say(`Here is the ${artifactType} artifact. `);
    events.push({
      type: "artifact-open",
      messageId,
      artifactId,
      revision: 1,
      title,
      artifactType,
      language,
    });
    for (let seq = 0, at = 0; at < content.length; seq++, at += deltaChars) {
      const delta = content.slice(at, at + deltaChars);
      events.push({ type: "artifact-delta", messageId, artifactId, revision: 1, seq, delta });
    }
    events.push({
      type: "artifact-close",
      messageId,
      artifactId,
      revision: 1,
      contentLength: content.length,
    });
  });

  say(types.length > 0 ? "All artifacts are ready." : "Done.");
  const outputTokens = events.filter((e) => e.type === "text-delta").length;
  const inputTokens = request.messages.reduce((sum, m) => sum + words(m.content).length, 0);
  events.push({
    type: "finish-message",
    messageId,
    finishReason: "stop",
    usage: { inputTokens, outputTokens },
  });
  return events;
}

/** One SSE frame in the agent wire protocol. */
export function encodeSseEvent(event: StreamEvent, id?: number): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const MALFORMED_FRAME = 'event: text-delta\ndata: {"type":"text-delta","messageId":\n\n';
const DONE_FRAME = "data: [DONE]\n\n";

function applyDeltaFaults(events: StreamEvent[], faults: MockFaults): StreamEvent[] {
  const dropped = new Set(faults.dropDeltaSeqs ?? []);
  const kept = events.filter((e) => !(e.type === "artifact-delta" && dropped.has(e.seq)));
  if (faults.reorderDeltas !== true) return kept;
  // Reverse each contiguous run of deltas, leaving every other event in place.
  const out: StreamEvent[] = [];
  let run: StreamEvent[] = [];
  for (const event of [...kept, null]) {
    if (event?.type === "artifact-delta") {
      run.push(event);
      continue;
    }
    out.push(...run.reverse());
    run = [];
    if (event !== null) out.push(event);
  }
  return out;
}

/** The SSE frames of a response, faults applied. `null` marks a stall. */
export function mockAgentFrames(
  request: AgentRequest,
  options: MockAgentOptions = {},
): (string | null)[] {
  const faults = options.faults ?? {};
  const events = applyDeltaFaults(mockAgentEvents(request, options), faults);
  const frames: (string | null)[] = [];
  for (const [index, event] of events.entries()) {
    if (index === faults.truncateAfter) return frames;
    if (index === faults.stallAfter) return [...frames, null];
    if (index === faults.malformedFrameAfter) frames.push(MALFORMED_FRAME);
    frames.push(encodeSseEvent(event, index + 1));
  }
  frames.push(DONE_FRAME);
  return frames;
}

const encoder = new TextEncoder();

/** Resolves after `ms`, or early when `signal` aborts; leaves no listener behind. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface MockAgentStats {
  /** Requests received, in order (after body validation). */
  requests: AgentRequest[];
  /** Responses answered with an injected error status. */
  failed: number;
  /** Bodies cancelled by the consumer. */
  cancelled: number;
  /** Requests whose signal aborted while the body was open. */
  aborted: number;
}

export interface MockAgentServer {
  fetch: typeof fetch;
  stats: MockAgentStats;
}

function problemJson(problem: ProblemDetails, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

/** A fetch-compatible mock agent backend. Ignores the URL; honours the request signal. */
export function createMockAgentServer(options: MockAgentOptions = {}): MockAgentServer {
  const faults = options.faults ?? {};
  const stats: MockAgentStats = { requests: [], failed: 0, cancelled: 0, aborted: 0 };

  const mockFetch = async (
    _input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;

    let request: AgentRequest;
    try {
      request = AgentRequestSchema.parse(JSON.parse(String(init.body)));
    } catch {
      return problemJson(createProblem("bad_request", { detail: "Invalid agent request" }), 400);
    }
    stats.requests.push(request);

    const status = faults.httpStatus;
    if (
      status !== undefined &&
      stats.requests.length <= (faults.failAttempts ?? Number.POSITIVE_INFINITY)
    ) {
      stats.failed++;
      const headers: Record<string, string> =
        faults.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(faults.retryAfterSeconds) };
      if (faults.problemBody === true) {
        const problem = createProblem("upstream_unavailable", {
          detail: `Mock agent injected ${status}`,
        });
        return problemJson({ ...problem, status }, status, headers);
      }
      return new Response(`mock agent error ${status}`, { status, headers });
    }

    const frames = mockAgentFrames(request, options);
    const chunkBytes = options.chunkBytes ?? Number.POSITIVE_INFINITY;
    const frameDelayMs = options.frameDelayMs ?? 0;
    const closed = new AbortController();
    let index = 0;
    let pending: Uint8Array = new Uint8Array(0);
    let onRequestAbort: () => void = () => undefined;
    // Once the body is done, stop listening to the request signal.
    closed.signal.addEventListener("abort", () =>
      signal?.removeEventListener("abort", onRequestAbort),
    );

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          onRequestAbort = () => {
            stats.aborted++;
            closed.abort();
            controller.error(signal?.reason);
          };
          signal?.addEventListener("abort", onRequestAbort, { once: true });
        },
        async pull(controller) {
          if (pending.byteLength === 0) {
            if (index >= frames.length) {
              closed.abort();
              controller.close();
              return;
            }
            const frame = frames[index++];
            if (frame === null || frame === undefined) {
              // Stall: never produce another byte until cancelled or aborted.
              await new Promise<void>((resolve) =>
                closed.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
              return;
            }
            if (frameDelayMs > 0) await delay(frameDelayMs, closed.signal);
            if (closed.signal.aborted) return;
            pending = encoder.encode(frame);
          }
          const size = Math.min(pending.byteLength, chunkBytes);
          controller.enqueue(pending.slice(0, size));
          pending = pending.slice(size);
        },
        cancel() {
          stats.cancelled++;
          closed.abort();
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  };

  return { fetch: mockFetch as typeof fetch, stats };
}
