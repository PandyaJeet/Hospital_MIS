import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";
import { getShellIdentity } from "@/lib/auth/shell-identity";

export default async function BillingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { role, fullName } = await getShellIdentity("billing");
  return (
    <AppShell role={role} fullName={fullName}>
      {children}
    </AppShell>
  );
}
