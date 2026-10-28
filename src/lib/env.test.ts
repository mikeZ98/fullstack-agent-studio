// @vitest-environment node
// t3-env treats any context with `window` as the client and then validates only the client
// schema, so server-side parsing must be exercised outside jsdom.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppEnv, env, type RuntimeEnv } from "./env";

const valid = {
  NODE_ENV: "production",
  BACKEND_SSE_URL: "https://agents.internal.invalid/v1/stream",
  NEXT_PUBLIC_API_URL: "https://studio.invalid/api",
} as const satisfies RuntimeEnv;

describe("createAppEnv", () => {
  beforeEach(() => {
    // t3-env reports the failing fields via console.error before throwing.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("parses a complete, valid environment", () => {
    expect(createAppEnv(valid)).toMatchObject(valid);
  });

  it("defaults AGENT_PROVIDER to upstream and accepts mock", () => {
    expect(createAppEnv(valid).AGENT_PROVIDER).toBe("upstream");
    expect(createAppEnv({ ...valid, AGENT_PROVIDER: "mock" }).AGENT_PROVIDER).toBe("mock");
  });

  it("defaults NODE_ENV to development when unset", () => {
    const { NODE_ENV: _omitted, ...rest } = valid;
    expect(createAppEnv(rest).NODE_ENV).toBe("development");
  });

  it.each([
    ["BACKEND_SSE_URL is missing", { BACKEND_SSE_URL: undefined }],
    ["BACKEND_SSE_URL is not a URL", { BACKEND_SSE_URL: "not a url" }],
    ["BACKEND_SSE_URL uses a non-http protocol", { BACKEND_SSE_URL: "ftp://agents.invalid/x" }],
    ["NEXT_PUBLIC_API_URL is missing", { NEXT_PUBLIC_API_URL: undefined }],
    ["NEXT_PUBLIC_API_URL is a javascript: URL", { NEXT_PUBLIC_API_URL: "javascript:alert(1)" }],
    ["NEXT_PUBLIC_API_URL is an empty string", { NEXT_PUBLIC_API_URL: "" }],
    ["NODE_ENV is not a known mode", { NODE_ENV: "staging" }],
    ["AGENT_PROVIDER is not a known provider", { AGENT_PROVIDER: "openai" }],
  ])("rejects the environment when %s", (_case, override: RuntimeEnv) => {
    expect(() => createAppEnv({ ...valid, ...override })).toThrow(/invalid environment variables/i);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("names every invalid variable in the validation report", () => {
    expect(() => createAppEnv({ NODE_ENV: "staging" })).toThrow();
    const report = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const key of ["NODE_ENV", "BACKEND_SSE_URL", "NEXT_PUBLIC_API_URL"]) {
      expect(report).toContain(key);
    }
  });

  it("returns raw values without validating when skipValidation is set", () => {
    const raw = { BACKEND_SSE_URL: "not a url" };
    expect(createAppEnv(raw, { skipValidation: true }).BACKEND_SSE_URL).toBe("not a url");
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("env (module singleton)", () => {
  it("is validated from process.env at import time", () => {
    expect(env).toMatchObject({
      NODE_ENV: "test",
      BACKEND_SSE_URL: "http://backend.invalid/v1/stream",
      NEXT_PUBLIC_API_URL: "http://studio.invalid/api",
    });
  });
});
