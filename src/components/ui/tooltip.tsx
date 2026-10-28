import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/**
 * Visual hint on hover and keyboard focus. It is decorative: the wrapped control must
 * carry its own accessible name (e.g. `aria-label`), so the hint is hidden from AT.
 */
export function Tooltip({ label, children, side = "bottom", className }: TooltipProps) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background opacity-0 transition-opacity",
          "group-focus-within/tooltip:opacity-100 group-hover/tooltip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {label}
      </span>
    </span>
  );
}
