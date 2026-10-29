// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ProblemDetailsSchema } from "@/lib/schemas";

import { createHealthHandler } from "./health";

describe("GET /api/health handler", () => {
  it("reports ok, the provider and whole seconds of uptime, uncached", async () => {
    const handle = createHealthHandler({
      loadEnv: async () => ({ AGENT_PROVIDER: "mock" }),
      uptime: () => 42.9,
    });
    const response = await handle();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", provider: "mock", uptimeSeconds: 42 });
  });

  it("uses the process uptime by default", async () => {
    const handle = createHealthHandler({ loadEnv: async () => ({ AGENT_PROVIDER: "upstream" }) });
    const body = (await (await handle()).json()) as { uptimeSeconds: number };
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("fails with a problem, without leaking the invalid values, when the env is invalid", async () => {
    const handle = createHealthHandler({
      loadEnv: async () => {
        throw new Error("BACKEND_SSE_URL=postgres://secret@db is invalid");
      },
    });
    const response = await handle();
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(ProblemDetailsSchema.parse(JSON.parse(text))).toMatchObject({
      code: "internal",
      detail: "Server configuration is invalid; see the server log",
    });
  });
});
