// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "./instrumentation";
import { validateEnvironmentOrExit } from "./instrumentation-node";

describe("boot-time environment validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes when the environment loads", async () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    await validateEnvironmentOrExit(async () => ({}), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when it does not", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.fn() as unknown as (code: number) => never;
    await validateEnvironmentOrExit(async () => {
      throw new Error("Invalid environment variables");
    }, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("Refusing to start: the server environment is invalid.");
  });

  it("validates the real environment by default (valid in tests)", async () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    await validateEnvironmentOrExit(undefined, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("register() validates on the Node.js runtime and skips the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(register()).resolves.toBeUndefined();
  });
});
