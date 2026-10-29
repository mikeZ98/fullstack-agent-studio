import { env } from "@/lib/env";
import { createAgentClient } from "@/lib/tools/agent-client";
import { createChatHandler } from "@/lib/tools/chat-handler";
import { createMockAgentServer } from "@/lib/tools/mock-agent-provider";

// Streams per request; never statically optimized or cached. Only Web APIs are used, so
// the handler runs on both the Node.js and Edge runtimes.
export const dynamic = "force-dynamic";

const client = createAgentClient({
  endpoint: env.BACKEND_SSE_URL,
  ...(env.AGENT_PROVIDER === "mock"
    ? {
        fetch: createMockAgentServer({ frameDelayMs: 20, toolSteps: 2, maxRecordedRequests: 0 })
          .fetch,
      }
    : {}),
});

const handleChat = createChatHandler({ client });

export function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
