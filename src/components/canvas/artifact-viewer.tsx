"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";

import type { ArtifactRecord } from "@/lib/core/artifact-reducer";
import type { CanvasViewMode } from "@/lib/schemas";

import { CodeView } from "../code-view";
import { ArtifactPreview } from "./artifact-preview";

/** What the canvas shows for a tab: the live revision or a pinned snapshot. */
export interface DisplayedArtifact {
  revision: number;
  title: string;
  type: ArtifactRecord["type"];
  language: string;
  content: string;
  /** The live revision is still streaming (never true for a pinned snapshot). */
  streaming: boolean;
  /** Showing an older revision than the latest. */
  pinned: boolean;
}

export function resolveDisplayed(
  record: ArtifactRecord,
  pinnedRevision?: number,
): DisplayedArtifact {
  const snapshot =
    pinnedRevision === undefined
      ? undefined
      : record.history.find((s) => s.revision === pinnedRevision);
  if (snapshot !== undefined && snapshot.revision !== record.revision) {
    const { revision, title, type, language, content } = snapshot;
    return { revision, title, type, language, content, streaming: false, pinned: true };
  }
  const { revision, title, type, language, content, state } = record;
  return {
    revision,
    title,
    type,
    language,
    content,
    streaming: state === "streaming",
    pinned: false,
  };
}

export interface ArtifactViewerProps {
  record: ArtifactRecord;
  displayed: DisplayedArtifact;
  viewMode: CanvasViewMode;
}

/**
 * Code or Preview for one artifact. While a revision is still streaming the live source is
 * shown; the preview only mounts once the artifact is sealed, so it never reloads per delta.
 */
export function ArtifactViewer({ record, displayed, viewMode }: ArtifactViewerProps) {
  const showError = record.state === "error" && !displayed.pinned && record.error !== undefined;
  const showCode = viewMode === "code" || displayed.streaming || showError;

  return (
    <div
      id="artifact-viewport"
      role="tabpanel"
      aria-labelledby={`tab-${record.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      {showError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-red-500/5 px-4 py-2 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600" />
          <p>
            <span className="font-medium">{record.error?.title}.</span>{" "}
            <span className="text-muted-foreground">{record.error?.detail}</span>
          </p>
        </div>
      )}
      {displayed.streaming && viewMode === "preview" && (
        <p
          role="status"
          className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground"
        >
          <LoaderCircle aria-hidden className="size-3 animate-spin" />
          Generating… the preview appears when the artifact is complete.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {showCode ? (
          <CodeView code={displayed.content} language={displayed.language} className="min-h-full" />
        ) : (
          <ArtifactPreview
            type={displayed.type}
            language={displayed.language}
            content={displayed.content}
            title={displayed.title}
          />
        )}
      </div>
    </div>
  );
}
