import { z } from "zod";

import { type ArtifactType, artifactSupportsPreview } from "./artifact";
import { LIMITS } from "./limits";
import { IdentifierSchema, RevisionSchema } from "./primitives";

export const CanvasViewModeSchema = z.enum(["preview", "code"]);
export type CanvasViewMode = z.infer<typeof CanvasViewModeSchema>;

/** One open artifact in the canvas tab strip. */
export const CanvasTabSchema = z.strictObject({
  artifactId: IdentifierSchema,
  viewMode: CanvasViewModeSchema,
  /** Show this revision instead of following the latest one. */
  pinnedRevision: RevisionSchema.optional(),
});
export type CanvasTab = z.infer<typeof CanvasTabSchema>;

export const SPLIT_RATIO_BOUNDS = { min: 0.2, max: 0.8 } as const;

/** Right-hand pane state: open tabs, focus and the chat/canvas split. */
export const CanvasStateSchema = z
  .strictObject({
    isOpen: z.boolean(),
    tabs: z.array(CanvasTabSchema).max(LIMITS.canvasTabs),
    activeArtifactId: IdentifierSchema.nullable(),
    /** Fraction of the viewport width given to the chat pane. */
    splitRatio: z.number().min(SPLIT_RATIO_BOUNDS.min).max(SPLIT_RATIO_BOUNDS.max),
  })
  .superRefine((state, ctx) => {
    const ids = state.tabs.map((tab) => tab.artifactId);
    ids.forEach((id, index) => {
      if (ids.indexOf(id) !== index) {
        ctx.addIssue({
          code: "custom",
          path: ["tabs", index, "artifactId"],
          message: `Duplicate tab for artifact "${id}"`,
        });
      }
    });
    if (state.activeArtifactId === null) {
      if (ids.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["activeArtifactId"],
          message: "Required while tabs are open",
        });
      }
    } else if (!ids.includes(state.activeArtifactId)) {
      ctx.addIssue({
        code: "custom",
        path: ["activeArtifactId"],
        message: "Must reference an open tab",
      });
    }
  });
export type CanvasState = z.infer<typeof CanvasStateSchema>;

export const INITIAL_CANVAS_STATE: CanvasState = {
  isOpen: false,
  tabs: [],
  activeArtifactId: null,
  splitRatio: 0.4,
};

/** Preview where the type can be rendered, otherwise straight to Code. */
export function defaultViewMode(type: ArtifactType): CanvasViewMode {
  return artifactSupportsPreview(type) ? "preview" : "code";
}

/** Whether `mode` can be shown for an artifact of `type`. */
export function isViewModeAvailable(type: ArtifactType, mode: CanvasViewMode): boolean {
  return mode === "code" || artifactSupportsPreview(type);
}
