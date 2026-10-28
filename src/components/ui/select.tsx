import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly SelectOption[];
}

/** Dropdown built on the native <select>, so keyboard and screen reader support is built in. */
export function Select({ options, className, ...props }: SelectProps) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        className={cn(
          "h-8 appearance-none rounded-md border bg-background py-0 pr-7 pl-2.5 text-xs",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
          "disabled:opacity-50",
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
