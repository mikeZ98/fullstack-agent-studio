import { LIMITS } from "@/lib/schemas";

import { problemResponse, readBody } from "./chat-handler";
import type { MockAgentServer } from "./mock-agent-provider";

/**
 * POST /api/mock-agent: the deterministic mock agent served over real HTTP, speaking the
 * agent SSE protocol. It lets one studio container act as the upstream of another, so the
 * whole upstream path (HTTP client, retries, SSE parsing) runs fully offline. It exists only
 * when AGENT_PROVIDER=mock; otherwise it is indistinguishable from an unknown route.
 */

export interface MockAgentHandlerOptions {
  enabled: boolean;
  server: MockAgentServer;
  maxBodyBytes?: number;
}

export function createMockAgentHandler(options: MockAgentHandlerOptions) {
  const { enabled, server, maxBodyBytes = LIMITS.requestBodyBytes } = options;

  return async function handleMockAgent(request: Request): Promise<Response> {
    if (!enabled) return new Response(null, { status: 404 });
    const body = await readBody(request, maxBodyBytes);
    if (!body.ok) return problemResponse(body.problem);
    // The mock validates the agent request itself and answers 400 when it is malformed.
    return server.fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: body.text,
      signal: request.signal,
    });
  };
}
