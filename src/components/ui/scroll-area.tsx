import type { HTMLAttributes, Ref } from "react";

import { cn } from "@/lib/utils";

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

/** Vertically scrolling region with a thin scrollbar and contained overscroll. */
export function ScrollArea({ className, ...props }: ScrollAreaProps) {
  return (
    <div
      className={cn(
        "min-h-0 [scrollbar-width:thin] overflow-y-auto overscroll-contain",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500",
        className,
      )}
      {...props}
    />
  );
}
