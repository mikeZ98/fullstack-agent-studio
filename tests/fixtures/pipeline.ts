// The production request path, in memory: the AI SDK's DefaultChatTransport POSTs to the
// real /api/chat handler (composed exactly as src/app/api/chat/route.ts composes it), whose
// agent client streams from an injected upstream fetch. Only the socket is missing.
import { DefaultChatTransport } from "ai";

import type { StreamOutcome } from "@/lib/core/stream-dispatcher";
import type { StudioUIMessage } from "@/lib/schemas";
import { type AgentClientOptions, createAgentClient } from "@/lib/tools/agent-client";
import { createChatHandler } from "@/lib/tools/chat-handler";

export const STUDIO_ORIGIN = "http://studio.invalid";
export const AGENT_ENDPOINT = "http://agent.invalid/v1/stream";

export interface RouteExchange {
  status: number;
  retryAfter: string | null;
}

export interface RoutePipeline {
  transport: DefaultChatTransport<StudioUIMessage>;
  /** POST /api/chat directly, as the browser would. */
  handle: (request: Request) => Promise<Response>;
  /** Every /api/chat response, in order. */
  exchanges: RouteExchange[];
  /** Backoff delays the agent client waited between upstream attempts. */
  delays: number[];
  /** How each bridged upstream stream ended. */
  outcomes: StreamOutcome[];
}

export interface RoutePipelineOptions {
  upstream: typeof fetch;
  /** Agent client overrides; sleep is instant (and recorded) and jitter is fixed by default. */
  client?: Partial<Omit<AgentClientOptions, "endpoint" | "fetch">>;
}

export function routePipeline({ upstream, client = {} }: RoutePipelineOptions): RoutePipeline {
  const delays: number[] = [];
  const outcomes: StreamOutcome[] = [];
  const exchanges: RouteExchange[] = [];
  const agent = createAgentClient({
    endpoint: AGENT_ENDPOINT,
    fetch: upstream,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    ...client,
  });
  const handle = createChatHandler({ client: agent, onOutcome: (o) => outcomes.push(o) });

  const transport = new DefaultChatTransport<StudioUIMessage>({
    api: "/api/chat",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await handle(new Request(new URL(String(input), STUDIO_ORIGIN), init));
      exchanges.push({ status: response.status, retryAfter: response.headers.get("retry-after") });
      return response;
    }) as typeof fetch,
  });
  return { transport, handle, exchanges, delays, outcomes };
}
