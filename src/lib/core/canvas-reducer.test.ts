import { describe, expect, it } from "vitest";
import { type ArtifactType, CanvasStateSchema, LIMITS, SPLIT_RATIO_BOUNDS } from "@/lib/schemas";
import { validEvents } from "~tests/fixtures/schemas";

import {
  type CanvasAction,
  type CanvasModel,
  canvasActionForEvent,
  canvasReducer,
  INITIAL_CANVAS_MODEL,
} from "./canvas-reducer";

const run = (actions: CanvasAction[], from: CanvasModel = INITIAL_CANVAS_MODEL) =>
  actions.reduce((model, action) => canvasReducer(Object.freeze(model), action), from);

const openTab = (
  artifactId: string,
  artifactType: ArtifactType = "html",
  activate?: boolean,
): CanvasAction => ({
  type: "open-tab",
  artifactId,
  artifactType,
  ...(activate === undefined ? {} : { activate }),
});
const ids = (model: CanvasModel) => model.canvas.tabs.map((tab) => tab.artifactId);

describe("canvasReducer — opening tabs", () => {
  it("opens the canvas on the first tab with the type's default view", () => {
    const model = run([openTab("a"), openTab("b", "code")]);
    expect(model.canvas).toMatchObject({
      isOpen: true,
      activeArtifactId: "b",
      tabs: [
        { artifactId: "a", viewMode: "preview" },
        { artifactId: "b", viewMode: "code" },
      ],
    });
    expect(model.recency).toEqual(["b", "a"]);
  });

  it("focuses an already-open tab instead of duplicating it", () => {
    const model = run([openTab("a"), openTab("b"), openTab("a")]);
    expect(ids(model)).toEqual(["a", "b"]);
    expect(model.canvas.activeArtifactId).toBe("a");
    expect(model.recency).toEqual(["a", "b"]);
  });

  it("opens in the background without stealing focus", () => {
    const base = run([openTab("a")]);
    const model = run([openTab("b", "html", false)], base);
    expect(model.canvas.activeArtifactId).toBe("a");
    expect(model.recency).toEqual(["a", "b"]);
    expect(run([openTab("b", "html", false)], model)).toBe(model);
  });

  it("activates a background tab when nothing else is open", () => {
    expect(run([openTab("a", "html", false)]).canvas).toMatchObject({
      activeArtifactId: "a",
      isOpen: true,
    });
  });
});

describe("canvasReducer — tab ceiling (LRU eviction)", () => {
  const fill = (count: number) => Array.from({ length: count }, (_, i) => openTab(`t${i}`));

  it("evicts the least recently used tab when the ceiling is exceeded", () => {
    const model = run(fill(LIMITS.canvasTabs + 1));
    expect(model.canvas.tabs).toHaveLength(LIMITS.canvasTabs);
    expect(ids(model)).not.toContain("t0");
    expect(model.canvas.activeArtifactId).toBe(`t${LIMITS.canvasTabs}`);
    expect(model.recency).toHaveLength(LIMITS.canvasTabs);
  });

  it("protects recently used tabs", () => {
    const model = run([
      ...fill(LIMITS.canvasTabs),
      { type: "set-active-tab", artifactId: "t0" },
      openTab("new"),
    ]);
    expect(ids(model)).toContain("t0");
    expect(ids(model)).not.toContain("t1");
  });

  it("never evicts the active tab or the background tab being opened", () => {
    const filled = run([...fill(LIMITS.canvasTabs), { type: "set-active-tab", artifactId: "t0" }]);
    const model = run([openTab("bg", "html", false)], filled);
    expect(ids(model)).toEqual(expect.arrayContaining(["t0", "bg"]));
    expect(ids(model)).not.toContain("t1");
    expect(model.canvas.activeArtifactId).toBe("t0");
  });
});

describe("canvasReducer — closing tabs", () => {
  const three = run([openTab("a"), openTab("b"), openTab("c")]);

  it("activates the tab that slides into the closed active slot", () => {
    const model = run(
      [
        { type: "set-active-tab", artifactId: "b" },
        { type: "close-tab", artifactId: "b" },
      ],
      three,
    );
    expect(ids(model)).toEqual(["a", "c"]);
    expect(model.canvas.activeArtifactId).toBe("c");
    expect(model.recency[0]).toBe("c");
  });

  it("falls back to the left neighbour when the last tab closes", () => {
    const model = run([{ type: "close-tab", artifactId: "c" }], three);
    expect(model.canvas.activeArtifactId).toBe("b");
  });

  it("keeps the active tab when closing another", () => {
    const model = run([{ type: "close-tab", artifactId: "a" }], three);
    expect(model.canvas.activeArtifactId).toBe("c");
    expect(model.recency).toEqual(["c", "b"]);
  });

  it("closes the canvas with its last tab", () => {
    const model = run([openTab("a"), { type: "close-tab", artifactId: "a" }]);
    expect(model).toEqual(INITIAL_CANVAS_MODEL);
  });

  it("is a no-op for an unknown tab", () => {
    expect(canvasReducer(three, { type: "close-tab", artifactId: "zzz" })).toBe(three);
  });
});

describe("canvasReducer — activation and view modes", () => {
  const model = run([openTab("page"), openTab("src", "code")]);

  it("ignores activating an unknown or already-active tab", () => {
    expect(canvasReducer(model, { type: "set-active-tab", artifactId: "zzz" })).toBe(model);
    expect(canvasReducer(model, { type: "set-active-tab", artifactId: "src" })).toBe(model);
  });

  it("reopens a hidden canvas when its active tab is selected", () => {
    const hidden = run([{ type: "set-open", isOpen: false }], model);
    expect(run([{ type: "set-active-tab", artifactId: "src" }], hidden).canvas.isOpen).toBe(true);
  });

  it("toggles Preview and Code for renderable artifacts", () => {
    const toggle: CanvasAction = {
      type: "toggle-view-mode",
      artifactId: "page",
      artifactType: "html",
    };
    const once = run([toggle], model);
    expect(once.canvas.tabs[0]?.viewMode).toBe("code");
    expect(run([toggle], once).canvas.tabs[0]?.viewMode).toBe("preview");
  });

  it("refuses Preview for code artifacts", () => {
    expect(
      canvasReducer(model, { type: "toggle-view-mode", artifactId: "src", artifactType: "code" }),
    ).toBe(model);
    expect(
      canvasReducer(model, {
        type: "set-view-mode",
        artifactId: "src",
        artifactType: "code",
        viewMode: "preview",
      }),
    ).toBe(model);
  });

  it("sets a view mode explicitly and ignores no-op changes", () => {
    const set = (viewMode: "preview" | "code"): CanvasAction => ({
      type: "set-view-mode",
      artifactId: "page",
      artifactType: "html",
      viewMode,
    });
    expect(canvasReducer(model, set("preview"))).toBe(model);
    expect(run([set("code")], model).canvas.tabs[0]?.viewMode).toBe("code");
    expect(
      canvasReducer(model, { type: "toggle-view-mode", artifactId: "zzz", artifactType: "html" }),
    ).toBe(model);
  });

  it("pins and unpins a revision", () => {
    const pinned = run([{ type: "pin-revision", artifactId: "page", revision: 2 }], model);
    expect(pinned.canvas.tabs[0]).toEqual({
      artifactId: "page",
      viewMode: "preview",
      pinnedRevision: 2,
    });
    expect(canvasReducer(pinned, { type: "pin-revision", artifactId: "page", revision: 2 })).toBe(
      pinned,
    );

    const unpinned = run([{ type: "pin-revision", artifactId: "page", revision: null }], pinned);
    expect(unpinned.canvas.tabs[0]).toEqual({ artifactId: "page", viewMode: "preview" });
    expect(
      canvasReducer(unpinned, { type: "pin-revision", artifactId: "page", revision: null }),
    ).toBe(unpinned);
  });
});

describe("canvasReducer — layout", () => {
  it.each([
    [0.5, 0.5],
    [0, SPLIT_RATIO_BOUNDS.min],
    [1, SPLIT_RATIO_BOUNDS.max],
  ])("clamps split ratio %d to %d", (ratio, expected) => {
    expect(run([{ type: "set-split-ratio", ratio }]).canvas.splitRatio).toBe(expected);
  });

  it("ignores NaN and unchanged split ratios", () => {
    const model = INITIAL_CANVAS_MODEL;
    expect(canvasReducer(model, { type: "set-split-ratio", ratio: Number.NaN })).toBe(model);
    expect(canvasReducer(model, { type: "set-split-ratio", ratio: model.canvas.splitRatio })).toBe(
      model,
    );
  });

  it("opens and closes the canvas", () => {
    const opened = run([{ type: "set-open", isOpen: true }]);
    expect(opened.canvas.isOpen).toBe(true);
    expect(canvasReducer(opened, { type: "set-open", isOpen: true })).toBe(opened);
  });
});

describe("canvasReducer — invariants under random action sequences", () => {
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 2, 3, 42, 1337])("keeps CanvasState valid (seed %i)", (seed) => {
    const random = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const artifactIds = Array.from({ length: LIMITS.canvasTabs + 6 }, (_, i) => `a${i}`);
    const types: ArtifactType[] = ["html", "code", "react", "svg"];
    let model = INITIAL_CANVAS_MODEL;

    for (let step = 0; step < 600; step++) {
      const artifactId = pick(artifactIds);
      const artifactType = pick(types);
      const action = pick<CanvasAction>([
        { type: "open-tab", artifactId, artifactType, activate: random() > 0.3 },
        { type: "close-tab", artifactId },
        { type: "set-active-tab", artifactId },
        { type: "toggle-view-mode", artifactId, artifactType },
        { type: "pin-revision", artifactId, revision: random() > 0.5 ? 1 : null },
        { type: "set-split-ratio", ratio: random() },
        { type: "set-open", isOpen: random() > 0.5 },
      ]);
      model = canvasReducer(model, action);

      expect(
        () => CanvasStateSchema.parse(model.canvas),
        `${seed}:${step} ${action.type}`,
      ).not.toThrow();
      expect([...model.recency].sort()).toEqual(ids(model).sort());
    }
  });
});

describe("canvasActionForEvent", () => {
  it("opens a focused tab for a new artifact", () => {
    expect(canvasActionForEvent(validEvents["artifact-open"])).toEqual({
      type: "open-tab",
      artifactId: "art_1",
      artifactType: "react",
    });
  });

  it("ignores every other event", () => {
    expect(canvasActionForEvent(validEvents["artifact-delta"])).toBeNull();
    expect(canvasActionForEvent(validEvents["text-delta"])).toBeNull();
  });
});
