"use client";

import { Check, CodeXml, Copy, Download, Eye, PanelRightClose } from "lucide-react";
import { useEffect, useState } from "react";

import { artifactFileName, artifactMimeType } from "@/lib/runner/files";
import { artifactSupportsPreview, type CanvasViewMode } from "@/lib/schemas";

import { ArtifactStatusBadge } from "../artifact-meta";
import { Button } from "../ui/button";
import { Tabs } from "../ui/tabs";
import { Tooltip } from "../ui/tooltip";
import type { DisplayedArtifact } from "./artifact-viewer";

export const COPIED_FEEDBACK_MS = 2000;

export function downloadArtifact(displayed: DisplayedArtifact): void {
  const blob = new Blob([displayed.content], { type: artifactMimeType(displayed.type) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = artifactFileName(displayed.title, displayed.language);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface CanvasToolbarProps {
  displayed: DisplayedArtifact;
  state: Parameters<typeof ArtifactStatusBadge>[0]["state"];
  viewMode: CanvasViewMode;
  onViewModeChange: (mode: CanvasViewMode) => void;
  onHide: () => void;
}

export function CanvasToolbar({
  displayed,
  state,
  viewMode,
  onViewModeChange,
  onHide,
}: CanvasToolbarProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(displayed.content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <Tabs<CanvasViewMode>
        label="View mode"
        value={viewMode}
        onValueChange={onViewModeChange}
        items={[
          {
            value: "preview",
            label: "Preview",
            icon: <Eye aria-hidden className="size-3.5" />,
            disabled: !artifactSupportsPreview(displayed.type),
          },
          { value: "code", label: "Code", icon: <CodeXml aria-hidden className="size-3.5" /> },
        ]}
      />
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {displayed.pinned ? `v${displayed.revision} (pinned)` : `v${displayed.revision}`}
      </span>
      {!displayed.pinned && <ArtifactStatusBadge state={state} />}
      <span className="ml-auto flex items-center gap-0.5">
        <Tooltip label={copied ? "Copied" : "Copy"}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={copied ? "Copied" : "Copy source"}
            onClick={() => void copy()}
            disabled={displayed.content === ""}
          >
            {copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <Copy aria-hidden className="size-4" />
            )}
          </Button>
        </Tooltip>
        <Tooltip label="Download">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Download"
            onClick={() => downloadArtifact(displayed)}
            disabled={displayed.streaming}
          >
            <Download aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip label="Hide canvas">
          <Button size="icon" variant="ghost" aria-label="Hide canvas" onClick={onHide}>
            <PanelRightClose aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </span>
    </div>
  );
}
