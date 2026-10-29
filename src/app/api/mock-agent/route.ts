import { env } from "@/lib/env";
import { createMockAgentServer } from "@/lib/tools/mock-agent-provider";
import { createMockAgentHandler } from "@/lib/tools/mock-agent-route";

export const dynamic = "force-dynamic";

const handleMockAgent = createMockAgentHandler({
  enabled: env.AGENT_PROVIDER === "mock",
  server: createMockAgentServer({ frameDelayMs: 20, toolSteps: 2, maxRecordedRequests: 0 }),
});

export function POST(request: Request): Promise<Response> {
  return handleMockAgent(request);
}
