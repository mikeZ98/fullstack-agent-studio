// @vitest-environment node
import { describe, expect, it } from "vitest";
import { agentRequest } from "~tests/fixtures/chat";

import * as route from "./route";

describe("POST /api/mock-agent", () => {
  it("does not exist unless AGENT_PROVIDER=mock (the test env is upstream)", async () => {
    const response = await route.POST(
      new Request("http://localhost/api/mock-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentRequest),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("only exports route fields Next.js accepts", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
  });
});
