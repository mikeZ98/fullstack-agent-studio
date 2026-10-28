"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

export interface TabItem<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string> {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  className?: string;
}

/**
 * Segmented tab list (WAI-ARIA tabs pattern): one tab stop, arrow keys / Home / End move
 * and select, disabled tabs are skipped.
 */
export function Tabs<V extends string>({
  label,
  items,
  value,
  onValueChange,
  className,
}: TabsProps<V>) {
  const refs = useRef(new Map<V, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items.filter((item) => item.disabled !== true);
    const index = enabled.findIndex((item) => item.value === value);
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    let next: TabItem<V> | undefined;
    if (event.key in step) {
      next = enabled[(index + (step[event.key] ?? 0) + enabled.length) % enabled.length];
    } else if (event.key === "Home") {
      next = enabled[0];
    } else if (event.key === "End") {
      next = enabled.at(-1);
    }
    if (next === undefined) return;
    event.preventDefault();
    onValueChange(next.value);
    refs.current.get(next.value)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node) refs.current.set(item.value, node);
              else refs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
