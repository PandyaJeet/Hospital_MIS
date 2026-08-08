import type { ReactNode } from "react";
import { Activity } from "lucide-react";

import { LanguageSwitcher } from "@/components/shared/language-switcher";

/** Standalone layout for auth screens — no role sidebar, language switcher up top. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2">
          <Activity
            className="h-5 w-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-text-primary">
            Hospital MIS
          </span>
        </div>
        <LanguageSwitcher />
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        {children}
      </div>
    </div>
  );
}
