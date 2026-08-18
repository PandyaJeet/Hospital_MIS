import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";
import { getShellIdentity } from "@/lib/auth/shell-identity";

export default async function NurseLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { role, fullName } = await getShellIdentity("nurse");
  return (
    <AppShell role={role} fullName={fullName}>
      {children}
    </AppShell>
  );
}
