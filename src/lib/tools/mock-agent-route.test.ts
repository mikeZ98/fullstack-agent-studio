// @vitest-environment node
import { describe, expect, it } from "vitest";
import { consumeEventStream } from "@/lib/core/stream-dispatcher";
import { agentRequest } from "~tests/fixtures/chat";

import { createAgentClient } from "./agent-client";
import { createMockAgentServer } from "./mock-agent-provider";
import { createMockAgentHandler } from "./mock-agent-route";

const URL = "http://mock-agent.invalid:3000/api/mock-agent";

function post(body: string, init: RequestInit = {}) {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ...init,
  });
}

describe("POST /api/mock-agent handler", () => {
  it("is indistinguishable from an unknown route unless enabled", async () => {
    const server = createMockAgentServer();
    const handle = createMockAgentHandler({ enabled: false, server });
    const response = await handle(post(JSON.stringify(agentRequest)));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(server.stats.received).toBe(0);
  });

  it("serves the agent SSE protocol to the real agent client over HTTP semantics", async () => {
    const server = createMockAgentServer({ toolSteps: 1, artifactTypes: ["mermaid"] });
    const handle = createMockAgentHandler({ enabled: true, server });
    // The upstream studio's client, with this handler standing in for the network.
    const client = createAgentClient({
      endpoint: URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        handle(new Request(input, init))) as typeof fetch,
    });
    const types: string[] = [];
    const outcome = await consumeEventStream(await client.stream(agentRequest), {
      handlers: { onEvent: (event) => void types.push(event.type) },
    });
    expect(outcome.status).toBe("done");
    expect(types).toEqual(expect.arrayContaining(["artifact-open", "tool-call", "finish-message"]));
    expect(server.stats.requests).toEqual([agentRequest]);
  });

  it("answers a malformed agent request with the mock's 400 problem", async () => {
    const handle = createMockAgentHandler({ enabled: true, server: createMockAgentServer() });
    const response = await handle(post('{"chatId":"c","messages":[]}'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_request" });
  });

  it("refuses an oversized body before buffering it", async () => {
    const server = createMockAgentServer();
    const handle = createMockAgentHandler({ enabled: true, server, maxBodyBytes: 16 });
    const response = await handle(post(JSON.stringify(agentRequest)));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
    expect(server.stats.received).toBe(0);
  });

  it("tears the stream down when the caller goes away", async () => {
    const server = createMockAgentServer({ artifactTypes: ["html"], frameDelayMs: 5 });
    const handle = createMockAgentHandler({ enabled: true, server });
    const controller = new AbortController();
    const response = await handle(
      post(JSON.stringify(agentRequest), { signal: controller.signal }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await expect(
      (async () => {
        for (let r = await reader?.read(); r !== undefined && !r.done; r = await reader?.read());
      })(),
    ).rejects.toBeDefined();
    expect(server.stats.aborted).toBe(1);
  });
});
