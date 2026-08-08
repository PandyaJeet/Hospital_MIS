import * as React from "react";

import { cn } from "@/lib/utils/cn";

/** Content-loading placeholder. Preferred over spinners for content (Design.md §5). */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-muted", className)}
      aria-hidden="true"
      {...props}
    />
  );
}
