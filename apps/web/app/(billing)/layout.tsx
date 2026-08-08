import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";

export default function BillingLayout({ children }: { children: ReactNode }) {
  return <AppShell role="billing">{children}</AppShell>;
}
