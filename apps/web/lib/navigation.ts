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

export type Role = "doctor" | "nurse" | "billing" | "admin";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const roleLabels: Record<Role, string> = {
  doctor: "Doctor",
  nurse: "Nurse",
  billing: "Billing",
  admin: "Admin",
};

/**
 * Top-level nav per role. Dynamic detail routes (patient/[id], invoice/[id],
 * vitals/[patientId]) are reached from within a screen, not the sidebar.
 */
export const roleNav: Record<Role, NavItem[]> = {
  doctor: [
    { label: "Queue", href: "/queue", icon: ListChecks },
    { label: "Prescribe", href: "/prescribe", icon: Pill },
    { label: "Rounds", href: "/rounds", icon: Stethoscope },
  ],
  nurse: [{ label: "Tasks", href: "/tasks", icon: ClipboardList }],
  billing: [
    { label: "Register", href: "/register", icon: UserPlus },
    { label: "Reconciliation", href: "/reconciliation", icon: Scale },
  ],
  admin: [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "Users", href: "/users", icon: Users },
    { label: "Settings", href: "/settings", icon: Settings },
  ],
};
