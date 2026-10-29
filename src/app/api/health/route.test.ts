// @vitest-environment node
import { describe, expect, it } from "vitest";

import * as route from "./route";

describe("GET /api/health", () => {
  it("reports a healthy, correctly configured server", async () => {
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", provider: "upstream" });
  });

  it("only exports route fields Next.js accepts", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });
});
