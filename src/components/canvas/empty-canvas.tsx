"use client";

import { PanelsTopLeft } from "lucide-react";

import { selectArtifacts } from "@/lib/core/artifact-reducer";

import { ARTIFACT_ICONS } from "../artifact-meta";
import { useStudio } from "../studio-provider";
import { Button } from "../ui/button";

/** Shown when no artifact tab is open; offers to reopen earlier artifacts. */
export function EmptyCanvas() {
  const { artifacts, activateArtifact } = useStudio();
  const recent = selectArtifacts(artifacts).slice(-5).reverse();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <PanelsTopLeft aria-hidden className="size-10 text-muted-foreground/60" />
      <h2 className="font-semibold">No artifact open</h2>
      <p className="max-w-xs text-sm text-muted-foreground">
        Ask for a page, a component, a diagram or some code. It streams in here and runs in an
        isolated sandbox.
      </p>
      {recent.length > 0 && (
        <ul aria-label="Recent artifacts" className="mt-2 flex flex-col gap-1.5">
          {recent.map((record) => {
            const Icon = ARTIFACT_ICONS[record.type];
            return (
              <li key={record.id}>
                <Button variant="outline" size="sm" onClick={() => activateArtifact(record.id)}>
                  <Icon aria-hidden className="size-3.5" />
                  {record.title}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
