import * as React from "react";

import { cn } from "@/lib/utils/cn";

type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "critical"
  | "info"
  | "accent";

// Semantic tones carry meaning (status), not decoration (Design.md §2).
const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-text-secondary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  critical: "bg-critical/10 text-critical",
  info: "bg-info/10 text-info",
  accent: "bg-accent-subtle text-accent",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
