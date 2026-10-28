// Runs under jsdom, where t3-env sees `window` and applies its client-side rules.
import { describe, expect, it } from "vitest";

import { env } from "./env";

describe("env on the client", () => {
  it("exposes NEXT_PUBLIC_* variables", () => {
    expect(env.NEXT_PUBLIC_API_URL).toBe("http://studio.invalid/api");
  });

  it("refuses to read server-only variables", () => {
    expect(() => env.BACKEND_SSE_URL).toThrow(/server-side environment variable on the client/i);
  });
});
