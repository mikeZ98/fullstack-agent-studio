import { describe, expect, it } from "vitest";

import { ArtifactTypeSchema } from "./artifact";
import {
  CanvasStateSchema,
  CanvasTabSchema,
  CanvasViewModeSchema,
  defaultViewMode,
  INITIAL_CANVAS_STATE,
  isViewModeAvailable,
  SPLIT_RATIO_BOUNDS,
} from "./canvas";
import { LIMITS } from "./limits";

const tab = (artifactId: string) => ({ artifactId, viewMode: "preview" as const });
const openState = {
  isOpen: true,
  tabs: [tab("art_1"), { artifactId: "art_2", viewMode: "code", pinnedRevision: 3 }],
  activeArtifactId: "art_2",
  splitRatio: 0.5,
};
const issuesOf = (value: unknown) => CanvasStateSchema.safeParse(value).error?.issues ?? [];

describe("CanvasViewModeSchema / CanvasTabSchema", () => {
  it("offers Preview and Code views", () => {
    expect(CanvasViewModeSchema.options).toEqual(["preview", "code"]);
  });

  it.each([
    ["an unknown view mode", { artifactId: "a", viewMode: "split" }],
    ["revision 0", { artifactId: "a", viewMode: "code", pinnedRevision: 0 }],
    ["unknown keys", { artifactId: "a", viewMode: "code", scrollTop: 10 }],
    ["an invalid id", { artifactId: "__proto__", viewMode: "code" }],
  ])("rejects a tab with %s", (_case, value) => {
    expect(CanvasTabSchema.safeParse(value).success).toBe(false);
  });
});

describe("CanvasStateSchema", () => {
  it("accepts the initial state", () => {
    expect(CanvasStateSchema.parse(INITIAL_CANVAS_STATE)).toEqual(INITIAL_CANVAS_STATE);
  });

  it("accepts open tabs with an active one", () => {
    expect(CanvasStateSchema.parse(openState)).toEqual(openState);
  });

  it("rejects duplicate tabs for the same artifact", () => {
    expect(issuesOf({ ...openState, tabs: [tab("art_2"), tab("art_2")] })).toEqual([
      expect.objectContaining({ path: ["tabs", 1, "artifactId"] }),
    ]);
  });

  it("rejects an active artifact that is not open", () => {
    expect(issuesOf({ ...openState, activeArtifactId: "art_9" })).toEqual([
      expect.objectContaining({
        path: ["activeArtifactId"],
        message: "Must reference an open tab",
      }),
    ]);
  });

  it("requires an active artifact while tabs are open", () => {
    expect(issuesOf({ ...openState, activeArtifactId: null })).toEqual([
      expect.objectContaining({
        path: ["activeArtifactId"],
        message: "Required while tabs are open",
      }),
    ]);
  });

  it("rejects an active artifact when no tabs are open", () => {
    expect(issuesOf({ ...INITIAL_CANVAS_STATE, activeArtifactId: "art_1" })).toHaveLength(1);
  });

  it("caps the number of tabs", () => {
    const tabs = Array.from({ length: LIMITS.canvasTabs + 1 }, (_, i) => tab(`art_${i}`));
    expect(issuesOf({ ...openState, tabs, activeArtifactId: "art_0" })).toContainEqual(
      expect.objectContaining({ path: ["tabs"] }),
    );
  });

  it.each([
    [SPLIT_RATIO_BOUNDS.min, true],
    [SPLIT_RATIO_BOUNDS.max, true],
    [SPLIT_RATIO_BOUNDS.min - 0.01, false],
    [SPLIT_RATIO_BOUNDS.max + 0.01, false],
    [Number.NaN, false],
  ])("splitRatio %d valid=%s", (splitRatio, valid) => {
    expect(CanvasStateSchema.safeParse({ ...openState, splitRatio }).success).toBe(valid);
  });

  it("rejects unknown keys", () => {
    expect(issuesOf({ ...openState, theme: "dark" })).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys" }),
    );
  });
});

describe("view mode helpers", () => {
  it.each(ArtifactTypeSchema.options)("picks a default view for %s", (type) => {
    expect(defaultViewMode(type)).toBe(type === "code" ? "code" : "preview");
  });

  it("only offers Preview for renderable types", () => {
    expect(isViewModeAvailable("code", "code")).toBe(true);
    expect(isViewModeAvailable("code", "preview")).toBe(false);
    expect(isViewModeAvailable("html", "preview")).toBe(true);
    expect(isViewModeAvailable("mermaid", "code")).toBe(true);
  });
});
