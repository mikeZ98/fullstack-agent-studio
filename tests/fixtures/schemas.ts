// Canonical valid payloads. Tests derive malformed variants from these so every rejection
// case differs from a known-good value by exactly one property.
import type { ArtifactPayload, ProblemDetails, StreamEvent, StreamEventType } from "@/lib/schemas";

export const validArtifact = {
  id: "art_1",
  revision: 1,
  title: "Pricing table",
  type: "react",
  language: "tsx",
  content: "export default function App() { return <table />; }",
  metadata: {
    description: "Interactive pricing comparison",
    tags: ["pricing", "ui"],
    sourceMessageId: "msg_1",
    createdAt: "2026-10-28T12:00:00Z",
    updatedAt: "2026-10-28T12:00:05+02:00",
  },
} as const satisfies ArtifactPayload;

export const validProblem = {
  type: "https://studio.example/problems/upstream-unavailable",
  title: "Agent backend unavailable",
  status: 503,
  detail: "Connection refused",
  code: "upstream_unavailable",
  retryable: true,
} as const satisfies ProblemDetails;

export const validEvents = {
  "start-message": { type: "start-message", messageId: "msg_1" },
  "text-delta": { type: "text-delta", messageId: "msg_1", delta: "Here is your table" },
  "tool-call": {
    type: "tool-call",
    messageId: "msg_1",
    toolCallId: "call_1",
    toolName: "web.search",
    input: { query: "pricing", filters: [{ field: "year", value: 2026 }], strict: true },
  },
  "tool-result": {
    type: "tool-result",
    messageId: "msg_1",
    toolCallId: "call_1",
    toolName: "web.search",
    output: { hits: [], total: 0, next: null },
    isError: false,
  },
  "artifact-open": {
    type: "artifact-open",
    messageId: "msg_1",
    artifactId: "art_1",
    revision: 1,
    title: "Pricing table",
    artifactType: "react",
    language: "tsx",
  },
  "artifact-delta": {
    type: "artifact-delta",
    messageId: "msg_1",
    artifactId: "art_1",
    revision: 1,
    delta: "export default function App() {",
  },
  "artifact-close": {
    type: "artifact-close",
    messageId: "msg_1",
    artifactId: "art_1",
    revision: 1,
    contentLength: 31,
  },
  "finish-message": {
    type: "finish-message",
    messageId: "msg_1",
    finishReason: "stop",
    usage: { inputTokens: 120, outputTokens: 480 },
  },
  error: { type: "error", messageId: "msg_1", error: validProblem },
} as const satisfies { [K in StreamEventType]: Extract<StreamEvent, { type: K }> };

/** Shallow copy of `base` with `changes` applied; `undefined` values delete the key. */
export function patch(base: object, changes: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
  }
  return copy;
}
