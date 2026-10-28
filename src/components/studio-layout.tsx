"use client";

import { MessagesSquare, PanelRight, PanelsTopLeft, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { INITIAL_CANVAS_STATE, SPLIT_RATIO_BOUNDS } from "@/lib/schemas";
import { cn } from "@/lib/utils";

import { CanvasPanel } from "./canvas/canvas-panel";
import { ChatPanel } from "./chat/chat-panel";
import { useMediaQuery } from "./hooks/use-media-query";
import { useStudio } from "./studio-provider";
import { Button } from "./ui/button";
import { ResizableSplitter } from "./ui/resizable-splitter";
import { Tabs } from "./ui/tabs";
import { Tooltip } from "./ui/tooltip";

export const DESKTOP_QUERY = "(min-width: 768px)";

type MobilePane = "chat" | "canvas";

/**
 * Split-pane shell. Desktop: chat and canvas side by side with a resizable splitter; the
 * chat pane animates to full width when the canvas hides and back when an artifact opens.
 * Mobile: one pane at a time, switching to the canvas whenever an artifact is focused.
 */
export function StudioLayout() {
  const { canvas, dispatchCanvas } = useStudio();
  const { isOpen, splitRatio, activeArtifactId, tabs } = canvas.canvas;
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-expand: a newly opened or focused artifact brings the canvas into view.
  useEffect(() => {
    if (isOpen && activeArtifactId !== null) setMobilePane("canvas");
  }, [isOpen, activeArtifactId]);

  const showCanvas = isDesktop ? isOpen : mobilePane === "canvas";
  const showChat = isDesktop || mobilePane === "chat";
  const chatWidth = isDesktop && isOpen ? `${splitRatio * 100}%` : "100%";

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Sparkles aria-hidden className="size-4 text-blue-500" />
        <h1 className="text-sm font-semibold">Agent Studio</h1>
        <span className="ml-auto">
          {isDesktop ? (
            <Tooltip label={isOpen ? "Hide canvas" : "Show canvas"}>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Canvas"
                aria-pressed={isOpen}
                aria-controls="canvas-pane"
                disabled={tabs.length === 0}
                onClick={() => dispatchCanvas({ type: "set-open", isOpen: !isOpen })}
              >
                <PanelRight aria-hidden className="size-4" />
              </Button>
            </Tooltip>
          ) : (
            <Tabs<MobilePane>
              label="Pane"
              value={mobilePane}
              onValueChange={setMobilePane}
              items={[
                {
                  value: "chat",
                  label: "Chat",
                  icon: <MessagesSquare aria-hidden className="size-3.5" />,
                },
                {
                  value: "canvas",
                  label: "Canvas",
                  icon: <PanelsTopLeft aria-hidden className="size-3.5" />,
                },
              ]}
            />
          )}
        </span>
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div
          id="chat-pane"
          hidden={!showChat}
          style={{ width: chatWidth }}
          className={cn(
            "min-w-0 shrink-0",
            !dragging && "transition-[width] duration-300 ease-out motion-reduce:transition-none",
          )}
        >
          <ChatPanel />
        </div>
        {isDesktop && isOpen && (
          <ResizableSplitter
            label="Resize chat and canvas"
            controls="chat-pane"
            containerRef={containerRef}
            value={splitRatio}
            min={SPLIT_RATIO_BOUNDS.min}
            max={SPLIT_RATIO_BOUNDS.max}
            defaultValue={INITIAL_CANVAS_STATE.splitRatio}
            onChange={(ratio) => dispatchCanvas({ type: "set-split-ratio", ratio })}
            onDraggingChange={setDragging}
          />
        )}
        <div id="canvas-pane" hidden={!showCanvas} className="min-w-0 flex-1">
          <CanvasPanel />
        </div>
      </div>
    </div>
  );
}
