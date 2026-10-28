// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createProblem } from "@/lib/schemas";
import { agentRequest, chatRequest } from "~tests/fixtures/chat";

import { type AgentClient, AgentClientError } from "./agent-client";
import { createChatHandler, problemResponse } from "./chat-handler";
import { createMockAgentServer } from "./mock-agent-provider";

const request = (body: BodyInit | null, init: RequestInit = {}) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
    ...init,
  });

const failingClient = (error: unknown): AgentClient => ({
  stream: vi.fn(async () => {
    throw error;
  }),
});

describe("createChatHandler", () => {
  it("passes the parsed agent request and the request signal to the client", async () => {
    const server = createMockAgentServer({ artifactTypes: [], toolSteps: 0 });
    const stream = vi.fn(async (_req, init?: { signal?: AbortSignal }) => {
      const res = await server.fetch("mock://", {
        method: "POST",
        body: JSON.stringify(agentRequest),
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return res.body ?? new ReadableStream();
    });
    const onOutcome = vi.fn();
    const response = await createChatHandler({ client: { stream }, onOutcome })(
      request(JSON.stringify(chatRequest)),
    );
    await response.text();

    expect(stream).toHaveBeenCalledWith(agentRequest, expect.anything());
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("treats a missing body as malformed JSON", async () => {
    const response = await createChatHandler({ client: failingClient(null) })(request(null));
    expect(response.status).toBe(400);
  });

  it("enforces a custom body limit", async () => {
    const handler = createChatHandler({ client: failingClient(null), maxBodyBytes: 10 });
    expect((await handler(request(JSON.stringify(chatRequest)))).status).toBe(413);
  });

  it("passes AgentClientError problems through, without Retry-After when unknown", async () => {
    const error = new AgentClientError(createProblem("upstream_unavailable"));
    const response = await createChatHandler({ client: failingClient(error) })(
      request(JSON.stringify(chatRequest)),
    );
    expect(response.status).toBe(503);
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it("rounds Retry-After up to whole seconds", async () => {
    const error = new AgentClientError(createProblem("rate_limited"), { retryAfterMs: 1500 });
    const response = await createChatHandler({ client: failingClient(error) })(
      request(JSON.stringify(chatRequest)),
    );
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("hides unexpected failures behind a generic 500", async () => {
    const response = await createChatHandler({
      client: failingClient(new Error("db password=hunter2")),
    })(request(JSON.stringify(chatRequest)));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });

  it("answers 499 when the client left before the upstream answered", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await createChatHandler({ client: failingClient(controller.signal.reason) })(
      request(JSON.stringify(chatRequest), { signal: controller.signal }),
    );
    expect(response.status).toBe(499);
  });
});

describe("problemResponse", () => {
  it("serializes the problem with its status and extra headers", async () => {
    const response = problemResponse(createProblem("rate_limited"), { "retry-after": "5" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({
      code: "rate_limited",
      title: "Too many requests",
    });
  });
});
