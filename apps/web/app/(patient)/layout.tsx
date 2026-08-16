import type { ReactNode } from "react";
import { Activity } from "lucide-react";

import { UserMenu } from "@/components/shared/user-menu";
import { getSessionIdentity } from "@/lib/auth/shell-identity";

/**
 * Minimal layout for the patient portal — no role sidebar. Design.md §8: the
 * patient view is intentionally the simplest of all personas.
 */
export default async function PatientLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { fullName } = await getSessionIdentity();
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-4">
        <Activity className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
        <span className="text-sm font-semibold text-text-primary">
          Hospital MIS
        </span>
        <div className="ml-auto">
          <UserMenu role="patient" fullName={fullName} />
        </div>
      </header>
      {children}
    </div>
  );
}
