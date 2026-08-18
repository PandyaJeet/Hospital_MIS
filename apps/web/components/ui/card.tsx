import * as React from "react";

import { cn } from "@/lib/utils/cn";

/** Surface container. Padding: 16px mobile / 24px desktop (Design.md §4). */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface p-4 sm:p-6",
        className,
      )}
      {...props}
    />
  );
}
