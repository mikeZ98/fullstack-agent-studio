// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { agentRequest, readText } from "~tests/fixtures/chat";

import {
  AgentClientError,
  type AgentClientOptions,
  createAgentClient,
  parseRetryAfter,
  problemFromResponse,
  sleep,
} from "./agent-client";
import { createMockAgentServer, type MockFaults } from "./mock-agent-provider";

const ENDPOINT = "https://agent.invalid/v1/stream";
const noSleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);

function client(fetch: typeof globalThis.fetch, options: Partial<AgentClientOptions> = {}) {
  return createAgentClient({
    endpoint: ENDPOINT,
    fetch,
    sleep: noSleep,
    random: () => 0,
    ...options,
  });
}

function failing(faults: MockFaults) {
  return createMockAgentServer({ artifactTypes: [], toolSteps: 0, faults });
}

async function rejection(promise: Promise<unknown>): Promise<AgentClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AgentClientError))
    throw new Error(`expected AgentClientError, got ${String(error)}`);
  return error;
}

describe("createAgentClient — streaming", () => {
  it("POSTs the agent request and returns the SSE body", async () => {
    const server = createMockAgentServer({ artifactTypes: [], toolSteps: 0 });
    const fetch = vi.fn(server.fetch);
    const body = await client(fetch, { headers: { authorization: "Bearer t" } }).stream(
      agentRequest,
    );
    const text = await readText(body);

    expect(text.startsWith("id: 1\nevent: start-message\ndata: ")).toBe(true);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(fetch).toHaveBeenCalledWith(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(agentRequest),
      signal: expect.any(AbortSignal),
      cache: "no-store",
    });
    expect(server.stats.requests).toEqual([agentRequest]);
  });

  it("resolves fetch from globalThis at call time", async () => {
    const server = createMockAgentServer({ artifactTypes: [], toolSteps: 0 });
    vi.stubGlobal("fetch", server.fetch);
    const body = await createAgentClient({ endpoint: ENDPOINT }).stream(agentRequest);
    expect(await readText(body)).toContain("finish-message");
  });

  it("rejects a 200 that is not an event stream", async () => {
    const fetch = vi.fn(
      async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    const error = await rejection(client(fetch).stream(agentRequest));
    expect(error.problem).toMatchObject({ code: "upstream_error", status: 502 });
    expect(error.problem.detail).toContain("text/html");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a 200 without a body", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const error = await rejection(client(fetch).stream(agentRequest));
    expect(error.problem.detail).toContain("no content type");
  });
});

describe("createAgentClient — upstream error translation", () => {
  it.each([
    [404, "upstream_error", 502, "Agent backend responded 404"],
    [400, "upstream_error", 502, "Agent backend responded 400"],
    [500, "upstream_error", 502, "Agent backend responded 500"],
    [401, "upstream_error", 502, "Agent backend refused credentials (401)"],
    [429, "rate_limited", 429, "Agent backend responded 429"],
    [502, "upstream_unavailable", 503, "Agent backend responded 502"],
    [503, "upstream_unavailable", 503, "Agent backend responded 503"],
    [504, "timeout", 504, "Agent backend responded 504"],
  ] as const)("maps upstream %i to %s (%i)", async (upstream, code, status, detail) => {
    const server = failing({ httpStatus: upstream });
    const error = await rejection(client(server.fetch, { maxRetries: 0 }).stream(agentRequest));
    expect(error.problem).toMatchObject({ code, status });
    expect(error.problem.detail).toContain(detail);
    expect(error.status).toBe(status);
    expect(error.options.upstreamStatus).toBe(upstream);
  });

  it("keeps the detail of an upstream RFC 9457 body", async () => {
    const server = failing({ httpStatus: 503, problemBody: true });
    const error = await rejection(client(server.fetch, { maxRetries: 0 }).stream(agentRequest));
    expect(error.problem.detail).toBe("Mock agent injected 503");
  });

  it("falls back when a JSON error body is not a problem", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{not json", { status: 500, headers: { "content-type": "application/json" } }),
    );
    const error = await rejection(client(fetch, { maxRetries: 0 }).stream(agentRequest));
    expect(error.problem.detail).toBe("Agent backend responded 500");
  });

  it("includes the status text when present", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 418, statusText: "I'm a teapot" }),
    );
    const error = await rejection(client(fetch).stream(agentRequest));
    expect(error.problem.detail).toBe("Agent backend responded 418 I'm a teapot");
  });

  it("reads at most a bounded error body", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16_384));
      },
    });
    const problem = await problemFromResponse(new Response(endless, { status: 500 }));
    expect(problem.code).toBe("upstream_error");
    expect(pulled).toBeLessThan(10);
  });
});

describe("createAgentClient — retries", () => {
  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const server = failing({ httpStatus: 503, failAttempts: 2 });
    const wait = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    const body = await client(server.fetch, { sleep: wait, random: () => 0 }).stream(agentRequest);

    expect(await readText(body)).toContain("[DONE]");
    expect(server.stats.requests).toHaveLength(3);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([125, 250]);
  });

  it("applies jitter and caps the backoff", async () => {
    const server = failing({ httpStatus: 502 });
    const wait = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    const options = {
      sleep: wait,
      random: () => 0.999,
      maxRetries: 4,
      baseDelayMs: 1000,
      maxDelayMs: 2500,
    };
    await rejection(client(server.fetch, options).stream(agentRequest));
    const delays = wait.mock.calls.map(([ms]) => Math.round(ms));
    expect(delays).toEqual([1000, 1999, 2499, 2499]);
  });

  it("waits at least Retry-After", async () => {
    const server = failing({ httpStatus: 429, failAttempts: 1, retryAfterSeconds: 3 });
    const wait = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    await client(server.fetch, { sleep: wait }).stream(agentRequest);
    expect(wait).toHaveBeenCalledWith(3000, undefined);
  });

  it("does not wait for a Retry-After beyond the cap", async () => {
    const server = failing({ httpStatus: 429, retryAfterSeconds: 60 });
    const error = await rejection(client(server.fetch).stream(agentRequest));
    expect(server.stats.requests).toHaveLength(1);
    expect(error.options.retryAfterMs).toBe(60_000);
  });

  it("gives up after maxRetries", async () => {
    const server = failing({ httpStatus: 503 });
    const error = await rejection(client(server.fetch, { maxRetries: 2 }).stream(agentRequest));
    expect(server.stats.requests).toHaveLength(3);
    expect(error.problem.code).toBe("upstream_unavailable");
  });

  it("never retries a non-transient failure", async () => {
    const server = failing({ httpStatus: 404 });
    await rejection(client(server.fetch).stream(agentRequest));
    expect(server.stats.requests).toHaveLength(1);
  });

  it("retries connection failures", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await rejection(client(fetch, { maxRetries: 1 }).stream(agentRequest));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error.problem).toMatchObject({ code: "upstream_unavailable", status: 503 });
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

/** A fetch that never answers until its signal aborts. */
const hangingFetch = vi.fn(
  (_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
);

describe("createAgentClient — timeouts", () => {
  it("times out waiting for response headers", async () => {
    const error = await rejection(
      client(hangingFetch, { connectTimeoutMs: 10, maxRetries: 0 }).stream(agentRequest),
    );
    expect(error.problem).toMatchObject({ code: "timeout", status: 504, retryable: true });
    expect(error.problem.detail).toBe("No response from agent backend within 10 ms");
  });

  it("aborts the upstream when the body stalls", async () => {
    const server = createMockAgentServer({
      artifactTypes: [],
      toolSteps: 0,
      faults: { stallAfter: 2 },
    });
    const body = await client(server.fetch, { idleTimeoutMs: 20 }).stream(agentRequest);

    const error = await readText(body).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).problem).toMatchObject({ code: "timeout" });
    expect(server.stats.aborted + server.stats.cancelled).toBeGreaterThan(0);
  });
});

describe("createAgentClient — cancellation", () => {
  it("does not call the backend for an already-aborted signal", async () => {
    const fetch = vi.fn(createMockAgentServer().fetch);
    const signal = AbortSignal.abort(new Error("gone"));
    await expect(client(fetch).stream(agentRequest, { signal })).rejects.toThrow("gone");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates an abort to the in-flight fetch", async () => {
    const controller = new AbortController();
    const pending = client(hangingFetch).stream(agentRequest, { signal: controller.signal });
    await vi.waitFor(() => expect(hangingFetch).toHaveBeenCalled());
    controller.abort(new Error("client left"));
    await expect(pending).rejects.toThrow("client left");
    const init = hangingFetch.mock.calls.at(-1)?.[1];
    expect(init?.signal?.aborted).toBe(true);
  });

  it("stops retrying when aborted during backoff", async () => {
    const controller = new AbortController();
    const server = failing({ httpStatus: 503 });
    const pending = client(server.fetch, { sleep, baseDelayMs: 10_000 }).stream(agentRequest, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(server.stats.requests).toHaveLength(1));
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    expect(server.stats.requests).toHaveLength(1);
  });

  it("aborts the upstream body when the caller aborts mid-stream", async () => {
    const controller = new AbortController();
    const server = createMockAgentServer({ artifactTypes: ["html"] });
    const body = await client(server.fetch).stream(agentRequest, { signal: controller.signal });
    const reader = body.getReader();
    await reader.read();
    controller.abort(new Error("client left"));

    await expect(reader.read()).rejects.toBeInstanceOf(AgentClientError);
    expect(server.stats.aborted).toBe(1);
  });

  it("aborts the upstream fetch and unhooks listeners when the consumer cancels", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const server = createMockAgentServer({ artifactTypes: ["html"] });
    const fetch = vi.fn(server.fetch);
    const body = await client(fetch).stream(agentRequest, { signal: controller.signal });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel("done here");

    expect(server.stats.cancelled + server.stats.aborted).toBeGreaterThan(0);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("unhooks listeners once the body completes", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const server = createMockAgentServer({ artifactTypes: [], toolSteps: 0 });
    const body = await client(server.fetch).stream(agentRequest, { signal: controller.signal });
    await readText(body);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("helpers", () => {
  it.each([
    [null, undefined],
    ["", undefined],
    ["  ", undefined],
    ["0", 0],
    ["120", 120_000],
    ["soon", undefined],
    ["Wed, 21 Oct 2026 07:28:10 GMT", 10_000],
    ["Wed, 21 Oct 2026 07:27:00 GMT", 0],
  ])("parseRetryAfter(%j) = %j", (value, expected) => {
    expect(parseRetryAfter(value, Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(expected);
  });

  it("sleep resolves after the delay and honours aborts", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    await expect(sleep(1, AbortSignal.abort("pre"))).rejects.toBe("pre");
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort("mid");
    await expect(pending).rejects.toBe("mid");
    const done = new AbortController();
    const remove = vi.spyOn(done.signal, "removeEventListener");
    await sleep(1, done.signal);
    expect(remove).toHaveBeenCalled();
  });
});
