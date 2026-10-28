"use client";

import { LoaderCircle, X } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";

import type { ArtifactRecord } from "@/lib/core/artifact-reducer";
import type { CanvasTab } from "@/lib/schemas";
import { cn } from "@/lib/utils";

import { ARTIFACT_ICONS } from "../artifact-meta";
import { Select } from "../ui/select";

export interface TabStripProps {
  tabs: readonly CanvasTab[];
  activeArtifactId: string | null;
  lookup: (artifactId: string) => ArtifactRecord | undefined;
  onSelect: (artifactId: string) => void;
  onClose: (artifactId: string) => void;
  onPinRevision: (artifactId: string, revision: number | null) => void;
}

export const LATEST = "latest";

/**
 * Open artifacts as tabs (WAI-ARIA tabs: arrows / Home / End move focus and select,
 * Delete closes), plus a revision picker for the active artifact.
 */
export function TabStrip({
  tabs,
  activeArtifactId,
  lookup,
  onSelect,
  onClose,
  onPinRevision,
}: TabStripProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const active = tabs.find((tab) => tab.artifactId === activeArtifactId);
  const activeRecord = active === undefined ? undefined : lookup(active.artifactId);

  function focusTab(index: number) {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (tab === undefined) return;
    onSelect(tab.artifactId);
    refs.current.get(tab.artifactId)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, artifactId: string) {
    switch (event.key) {
      case "ArrowRight":
        focusTab(index + 1);
        break;
      case "ArrowLeft":
        focusTab(index - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(tabs.length - 1);
        break;
      case "Delete":
        onClose(artifactId);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className="flex items-center gap-2 border-b px-2">
      <div
        role="tablist"
        aria-label="Open artifacts"
        className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pt-2"
      >
        {tabs.map((tab, index) => {
          const record = lookup(tab.artifactId);
          const selected = tab.artifactId === activeArtifactId;
          const title = record?.title ?? tab.artifactId;
          const Icon = record === undefined ? null : ARTIFACT_ICONS[record.type];
          return (
            <div
              key={tab.artifactId}
              className={cn(
                "group flex max-w-52 shrink-0 items-center rounded-t-md border border-b-0 text-xs",
                selected
                  ? "bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60",
              )}
            >
              <button
                ref={(node) => {
                  if (node) refs.current.set(tab.artifactId, node);
                  else refs.current.delete(tab.artifactId);
                }}
                type="button"
                role="tab"
                id={`tab-${tab.artifactId}`}
                aria-selected={selected}
                aria-controls="artifact-viewport"
                aria-keyshortcuts="Delete"
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(tab.artifactId)}
                onKeyDown={(event) => onKeyDown(event, index, tab.artifactId)}
                className="flex min-w-0 items-center gap-1.5 py-1.5 pr-1 pl-2.5 focus-visible:outline-2 focus-visible:outline-blue-500"
              >
                {record?.state === "streaming" ? (
                  <LoaderCircle
                    aria-label="Generating"
                    className="size-3.5 shrink-0 animate-spin"
                  />
                ) : (
                  Icon !== null && <Icon aria-hidden className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${title}`}
                onClick={() => onClose(tab.artifactId)}
                className="mr-1 grid size-5 shrink-0 place-items-center rounded opacity-60 hover:bg-muted hover:opacity-100"
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      {active !== undefined && activeRecord !== undefined && activeRecord.history.length > 0 && (
        <Select
          aria-label="Revision"
          value={active.pinnedRevision === undefined ? LATEST : String(active.pinnedRevision)}
          onChange={(event) => {
            const { value } = event.target;
            onPinRevision(active.artifactId, value === LATEST ? null : Number(value));
          }}
          options={[
            { value: LATEST, label: `Latest (v${activeRecord.revision})` },
            ...[...activeRecord.history].reverse().map((snapshot) => ({
              value: String(snapshot.revision),
              label: `v${snapshot.revision}`,
            })),
          ]}
          className="shrink-0"
        />
      )}
    </div>
  );
}
