import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Empty states always include a clear next action (Design.md §5). */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center",
        className,
      )}
    >
      {Icon ? (
        <Icon className="h-8 w-8 text-text-disabled" aria-hidden="true" />
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium text-text-primary">{title}</h3>
        {description ? (
          <p className="max-w-sm text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
