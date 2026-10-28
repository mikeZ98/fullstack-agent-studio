import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("joins class names and drops falsy values", () => {
    expect(cn("px-2", false, null, undefined, "", "py-1")).toBe("px-2 py-1");
  });

  it("supports conditional object and array syntax", () => {
    expect(cn(["flex", { hidden: false, "items-center": true }])).toBe("flex items-center");
  });

  it("lets later Tailwind utilities override conflicting earlier ones", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });
});
