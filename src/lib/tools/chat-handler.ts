import { createUIMessageStreamResponse } from "ai";
import { guardChatRequest } from "@/lib/guardrails/input-guardrails";
import {
  ChatRequestSchema,
  createProblem,
  formatIssues,
  LIMITS,
  type ProblemDetails,
  toAgentRequest,
} from "@/lib/schemas";

import { type AgentClient, AgentClientError } from "./agent-client";
import { type BridgeOptions, bridgeAgentStream } from "./stream-bridge";

/** RFC 9457 response; never cached. */
export function problemResponse(problem: ProblemDetails, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: {
      ...headers,
      "content-type": "application/problem+json",
      "cache-control": "no-store",
    },
  });
}

export type BodyResult = { ok: true; text: string } | { ok: false; problem: ProblemDetails };

/** Read the request body without ever buffering more than `limit` bytes. */
export async function readBody(request: Request, limit: number): Promise<BodyResult> {
  const tooLarge = () =>
    ({
      ok: false,
      problem: createProblem("payload_too_large", {
        detail: `Request body exceeds ${limit} bytes`,
      }),
    }) as const;

  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (declared > limit) return tooLarge();
  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, text: text + decoder.decode() };
      bytes += value.byteLength;
      if (bytes > limit) return tooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface ChatHandlerOptions {
  client: AgentClient;
  maxBodyBytes?: number;
  onOutcome?: BridgeOptions["onOutcome"];
}

/**
 * POST /api/chat: validate the AI SDK chat request, open the upstream agent stream and
 * answer with a UI message stream. Every failure before streaming starts is an RFC 9457
 * problem; failures after that travel in-band as `error` chunks.
 */
export function createChatHandler(options: ChatHandlerOptions) {
  const { client, maxBodyBytes = LIMITS.requestBodyBytes } = options;

  return async function handleChat(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      const detail = `Expected application/json, got ${contentType || "no content type"}`;
      return problemResponse(createProblem("unsupported_media_type", { detail }));
    }

    const body = await readBody(request, maxBodyBytes);
    if (!body.ok) return problemResponse(body.problem);

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return problemResponse(
        createProblem("bad_request", { detail: "Request body is not valid JSON" }),
      );
    }

    const parsed = ChatRequestSchema.safeParse(json);
    if (!parsed.success) {
      const errors = formatIssues(parsed.error.issues);
      return problemResponse(
        createProblem("validation_failed", { detail: "Invalid chat request", errors }),
      );
    }

    // Input guardrails: sanitise every turn, refuse injection attempts in any user turn.
    const guarded = guardChatRequest(parsed.data);
    if (!guarded.ok) return problemResponse(guarded.problem);

    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await client.stream(toAgentRequest(guarded.request), { signal: request.signal });
    } catch (error) {
      if (error instanceof AgentClientError) {
        const retryAfterMs = error.options.retryAfterMs;
        const headers: Record<string, string> =
          retryAfterMs === undefined
            ? {}
            : { "retry-after": String(Math.ceil(retryAfterMs / 1000)) };
        return problemResponse(error.problem, headers);
      }
      if (request.signal.aborted) {
        // The client is gone; nobody will read this.
        return new Response(null, { status: 499 });
      }
      return problemResponse(createProblem("internal", { detail: "Unexpected gateway failure" }));
    }

    const stream = bridgeAgentStream(upstream, {
      signal: request.signal,
      ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
    });
    return createUIMessageStreamResponse({ stream });
  };
}
