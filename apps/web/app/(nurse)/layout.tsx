import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";

export default function NurseLayout({ children }: { children: ReactNode }) {
  return <AppShell role="nurse">{children}</AppShell>;
}
