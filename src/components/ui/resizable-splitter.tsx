"use client";

import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

export interface ResizableSplitterProps {
  /** Fraction of the container given to the leading pane. */
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Double-click restores this value. */
  defaultValue?: number;
  /** Element whose width the fraction is measured against. */
  containerRef: RefObject<HTMLElement | null>;
  /** Id of the pane this splitter resizes. */
  controls: string;
  label: string;
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
}

const STEP = 0.02;
const PAGE_STEP = 0.1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Vertical window splitter (WAI-ARIA "window splitter" pattern): draggable with a pointer,
 * adjustable with arrow keys, Page Up/Down and Home/End, reset by double-click.
 */
export function ResizableSplitter({
  value,
  min,
  max,
  onChange,
  defaultValue,
  containerRef,
  controls,
  label,
  onDraggingChange,
  className,
}: ResizableSplitterProps) {
  const dragging = useRef(false);

  function ratioAt(clientX: number): number | null {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return null;
    return clamp((clientX - rect.left) / rect.width, min, max);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = true;
    onDraggingChange?.(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const next = ratioAt(event.clientX);
    if (next !== null) onChange(next);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onDraggingChange?.(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: value - STEP,
      ArrowDown: value - STEP,
      ArrowRight: value + STEP,
      ArrowUp: value + STEP,
      PageDown: value - PAGE_STEP,
      PageUp: value + PAGE_STEP,
      Home: min,
      End: max,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next, min, max));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot be focused or dragged; this is the ARIA window-splitter pattern.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      className={cn(
        "group relative w-px shrink-0 cursor-col-resize touch-none bg-border",
        "focus-visible:outline-none",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 -left-1.5 w-3 transition-colors group-hover:bg-blue-500/20 group-focus-visible:bg-blue-500/30 group-active:bg-blue-500/30"
      />
    </div>
  );
}
