import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  Pill,
  Scale,
  Settings,
  Stethoscope,
  UserPlus,
  Users,
} from "lucide-react";

import type { ShellRole } from "./roles";

export type { ShellRole };

export interface NavItem {
  /** Key into the `nav` message namespace (see messages/*.json). */
  key: string;
  href: string;
  icon: LucideIcon;
}

/**
 * Top-level nav per role. Dynamic detail routes (patient/[id], invoice/[id],
 * vitals/[patientId]) are reached from within a screen, not the sidebar.
 */
export const roleNav: Record<ShellRole, NavItem[]> = {
  doctor: [
    { key: "queue", href: "/queue", icon: ListChecks },
    { key: "prescribe", href: "/prescribe", icon: Pill },
    { key: "rounds", href: "/rounds", icon: Stethoscope },
  ],
  nurse: [{ key: "tasks", href: "/tasks", icon: ClipboardList }],
  billing: [
    { key: "register", href: "/register", icon: UserPlus },
    { key: "reconciliation", href: "/reconciliation", icon: Scale },
  ],
  admin: [
    { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
    { key: "users", href: "/users", icon: Users },
    { key: "settings", href: "/settings", icon: Settings },
  ],
};
