import {
  type ArtifactType,
  type CanvasState,
  type CanvasTab,
  type CanvasViewMode,
  defaultViewMode,
  type Identifier,
  INITIAL_CANVAS_STATE,
  isViewModeAvailable,
  LIMITS,
  SPLIT_RATIO_BOUNDS,
  type StreamEvent,
} from "@/lib/schemas";

/**
 * Canvas state plus tab recency. Recency lives beside the wire-level CanvasState (rather
 * than inside it) so CanvasState stays a strict, persistable contract.
 */
export interface CanvasModel {
  readonly canvas: CanvasState;
  /** Open tab ids, most recently used first. */
  readonly recency: readonly Identifier[];
}

export type CanvasAction =
  | { type: "open-tab"; artifactId: Identifier; artifactType: ArtifactType; activate?: boolean }
  | { type: "close-tab"; artifactId: Identifier }
  | { type: "set-active-tab"; artifactId: Identifier }
  | { type: "toggle-view-mode"; artifactId: Identifier; artifactType: ArtifactType }
  | {
      type: "set-view-mode";
      artifactId: Identifier;
      artifactType: ArtifactType;
      viewMode: CanvasViewMode;
    }
  | { type: "pin-revision"; artifactId: Identifier; revision: number | null }
  | { type: "set-split-ratio"; ratio: number }
  | { type: "set-open"; isOpen: boolean };

export const INITIAL_CANVAS_MODEL: CanvasModel = { canvas: INITIAL_CANVAS_STATE, recency: [] };

function touch(recency: readonly Identifier[], id: Identifier): Identifier[] {
  return [id, ...recency.filter((other) => other !== id)];
}

function updateTab(
  model: CanvasModel,
  artifactId: Identifier,
  update: (tab: CanvasTab) => CanvasTab,
): CanvasModel {
  const index = model.canvas.tabs.findIndex((tab) => tab.artifactId === artifactId);
  const current = model.canvas.tabs[index];
  if (current === undefined) return model;
  const next = update(current);
  if (next === current) return model;
  const tabs = model.canvas.tabs.with(index, next);
  return { ...model, canvas: { ...model.canvas, tabs } };
}

function openTab(model: CanvasModel, action: Extract<CanvasAction, { type: "open-tab" }>) {
  const { artifactId, artifactType } = action;
  const { canvas } = model;
  const exists = canvas.tabs.some((tab) => tab.artifactId === artifactId);
  const activate = action.activate !== false || canvas.activeArtifactId === null;

  if (exists) {
    return activate ? setActive(model, artifactId) : model;
  }

  let tabs = [...canvas.tabs, { artifactId, viewMode: defaultViewMode(artifactType) }];
  let recency = activate ? [artifactId, ...model.recency] : [...model.recency, artifactId];
  const activeArtifactId = activate ? artifactId : canvas.activeArtifactId;

  // Over the ceiling: evict the least recently used tab, never the one being opened
  // and never the active one.
  while (tabs.length > LIMITS.canvasTabs) {
    const victim = recency.findLast((id) => id !== artifactId && id !== activeArtifactId);
    if (victim === undefined) break;
    tabs = tabs.filter((tab) => tab.artifactId !== victim);
    recency = recency.filter((id) => id !== victim);
  }

  return {
    canvas: { ...canvas, isOpen: canvas.isOpen || activate, tabs, activeArtifactId },
    recency,
  };
}

function closeTab(model: CanvasModel, artifactId: Identifier): CanvasModel {
  const { canvas } = model;
  const index = canvas.tabs.findIndex((tab) => tab.artifactId === artifactId);
  if (index === -1) return model;

  const tabs = canvas.tabs.toSpliced(index, 1);
  const recency = model.recency.filter((id) => id !== artifactId);
  let { activeArtifactId } = canvas;
  if (activeArtifactId === artifactId) {
    // Fall back to the tab that slid into the closed slot, else its left neighbour.
    activeArtifactId = (tabs[index] ?? tabs[index - 1])?.artifactId ?? null;
  }
  const nextRecency = activeArtifactId === null ? recency : touch(recency, activeArtifactId);
  return {
    canvas: { ...canvas, tabs, activeArtifactId, isOpen: canvas.isOpen && tabs.length > 0 },
    recency: nextRecency,
  };
}

function setActive(model: CanvasModel, artifactId: Identifier): CanvasModel {
  const { canvas } = model;
  if (!canvas.tabs.some((tab) => tab.artifactId === artifactId)) return model;
  if (canvas.activeArtifactId === artifactId && canvas.isOpen) return model;
  return {
    canvas: { ...canvas, activeArtifactId: artifactId, isOpen: true },
    recency: touch(model.recency, artifactId),
  };
}

function withViewMode(type: ArtifactType, viewMode: CanvasViewMode) {
  return (tab: CanvasTab): CanvasTab =>
    tab.viewMode === viewMode || !isViewModeAvailable(type, viewMode) ? tab : { ...tab, viewMode };
}

/**
 * Pure canvas reducer. Every transition keeps CanvasStateSchema's invariants (unique tabs,
 * at most LIMITS.canvasTabs, active tab open). No-ops return the same model object.
 */
export function canvasReducer(model: CanvasModel, action: CanvasAction): CanvasModel {
  switch (action.type) {
    case "open-tab":
      return openTab(model, action);
    case "close-tab":
      return closeTab(model, action.artifactId);
    case "set-active-tab":
      return setActive(model, action.artifactId);
    case "toggle-view-mode":
      return updateTab(model, action.artifactId, (tab) =>
        withViewMode(action.artifactType, tab.viewMode === "preview" ? "code" : "preview")(tab),
      );
    case "set-view-mode":
      return updateTab(
        model,
        action.artifactId,
        withViewMode(action.artifactType, action.viewMode),
      );
    case "pin-revision":
      return updateTab(model, action.artifactId, (tab) => {
        if (action.revision === null) {
          if (tab.pinnedRevision === undefined) return tab;
          const { pinnedRevision: _unpinned, ...rest } = tab;
          return rest;
        }
        return tab.pinnedRevision === action.revision
          ? tab
          : { ...tab, pinnedRevision: action.revision };
      });
    case "set-split-ratio": {
      if (Number.isNaN(action.ratio)) return model;
      const splitRatio = Math.min(
        SPLIT_RATIO_BOUNDS.max,
        Math.max(SPLIT_RATIO_BOUNDS.min, action.ratio),
      );
      if (splitRatio === model.canvas.splitRatio) return model;
      return { ...model, canvas: { ...model.canvas, splitRatio } };
    }
    case "set-open":
      if (action.isOpen === model.canvas.isOpen) return model;
      return { ...model, canvas: { ...model.canvas, isOpen: action.isOpen } };
  }
}

/** Canvas reaction to a stream event: a newly opened artifact gets a focused tab. */
export function canvasActionForEvent(event: StreamEvent): CanvasAction | null {
  return event.type === "artifact-open"
    ? { type: "open-tab", artifactId: event.artifactId, artifactType: event.artifactType }
    : null;
}
