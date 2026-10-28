"use client";

import { selectArtifact } from "@/lib/core/artifact-reducer";
import { artifactSupportsPreview } from "@/lib/schemas";

import { useStudio } from "../studio-provider";
import { ArtifactViewer, resolveDisplayed } from "./artifact-viewer";
import { CanvasToolbar } from "./canvas-toolbar";
import { EmptyCanvas } from "./empty-canvas";
import { TabStrip } from "./tab-strip";

/** Right pane: artifact tabs, toolbar and the active artifact's viewer. */
export function CanvasPanel() {
  const { artifacts, canvas, dispatchCanvas } = useStudio();
  const { tabs, activeArtifactId } = canvas.canvas;
  const tab = tabs.find((t) => t.artifactId === activeArtifactId);
  const record = tab === undefined ? undefined : selectArtifact(artifacts, tab.artifactId);

  return (
    <section aria-label="Canvas" className="flex h-full min-h-0 flex-col bg-muted/20">
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          activeArtifactId={activeArtifactId}
          lookup={(id) => selectArtifact(artifacts, id)}
          onSelect={(artifactId) => dispatchCanvas({ type: "set-active-tab", artifactId })}
          onClose={(artifactId) => dispatchCanvas({ type: "close-tab", artifactId })}
          onPinRevision={(artifactId, revision) =>
            dispatchCanvas({ type: "pin-revision", artifactId, revision })
          }
        />
      )}
      {tab === undefined || record === undefined ? (
        <EmptyCanvas />
      ) : (
        (() => {
          const displayed = resolveDisplayed(record, tab.pinnedRevision);
          // A pinned snapshot may be of a different type than the live revision.
          const viewMode = artifactSupportsPreview(displayed.type) ? tab.viewMode : "code";
          return (
            <>
              <CanvasToolbar
                displayed={displayed}
                state={record.state}
                viewMode={viewMode}
                onViewModeChange={(mode) =>
                  dispatchCanvas({
                    type: "set-view-mode",
                    artifactId: record.id,
                    artifactType: displayed.type,
                    viewMode: mode,
                  })
                }
                onHide={() => dispatchCanvas({ type: "set-open", isOpen: false })}
              />
              <ArtifactViewer record={record} displayed={displayed} viewMode={viewMode} />
            </>
          );
        })()
      )}
    </section>
  );
}
