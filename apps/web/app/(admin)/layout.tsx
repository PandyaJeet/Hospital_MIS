import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AppShell role="admin">{children}</AppShell>;
}
