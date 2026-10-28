"use client";

import { ChevronRight } from "lucide-react";

import { selectArtifact } from "@/lib/core/artifact-reducer";
import { cn } from "@/lib/utils";

import { ARTIFACT_ICONS, ARTIFACT_TYPE_LABELS, ArtifactStatusBadge } from "../artifact-meta";
import { useStudio } from "../studio-provider";
import { Badge } from "../ui/badge";

export interface InlineArtifactCardProps {
  artifactId: string;
  /** Title from the message part, shown until the store has the artifact. */
  fallbackTitle: string;
}

/** In-chat reference to an artifact; reflects its live status and focuses it in the canvas. */
export function InlineArtifactCard({ artifactId, fallbackTitle }: InlineArtifactCardProps) {
  const { artifacts, canvas, activateArtifact } = useStudio();
  const record = selectArtifact(artifacts, artifactId);
  const active = canvas.canvas.isOpen && canvas.canvas.activeArtifactId === artifactId;
  const Icon = record === undefined ? null : ARTIFACT_ICONS[record.type];

  return (
    <button
      type="button"
      onClick={() => activateArtifact(artifactId)}
      disabled={record === undefined}
      aria-pressed={active}
      aria-label={`Open ${record?.title ?? fallbackTitle} in canvas`}
      className={cn(
        "my-2 flex w-full max-w-md items-center gap-3 rounded-lg border bg-background p-3 text-left transition-colors",
        "hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-blue-500",
        active && "border-blue-500/60 bg-blue-500/5",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
        {Icon !== null && <Icon aria-hidden className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{record?.title ?? fallbackTitle}</span>
        {record !== undefined && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>{ARTIFACT_TYPE_LABELS[record.type]}</Badge>
            <Badge>{record.language}</Badge>
            <Badge>v{record.revision}</Badge>
            <ArtifactStatusBadge state={record.state} />
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
