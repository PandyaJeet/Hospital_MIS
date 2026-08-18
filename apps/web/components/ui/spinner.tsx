import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/** Inline loading indicator for actions (e.g. a saving button), not full pages. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("h-4 w-4 animate-spin", className)}
      aria-hidden="true"
    />
  );
}
