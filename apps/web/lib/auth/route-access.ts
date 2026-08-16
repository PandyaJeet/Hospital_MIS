import { roleHomePath, type Role } from "@/lib/roles";

/**
 * Which path prefixes each role may reach.
 *
 * This is navigational scoping, not the security boundary — that is Postgres RLS
 * (rules.md §1, §4). A doctor who forced their way to /charges would still see
 * nothing they are not permitted to read. The point here is that a role never
 * lands on a screen built for someone else's job.
 *
 * `patient` is deliberately narrow: the `patient` role matches no rows on
 * `patients` in Phase 2, so the staff screens would be empty anyway.
 */
const STAFF_PATIENT_ACCESS = ["/patient"];

const roleRoutes: Record<Role, string[]> = {
  // A pending user has no tenant yet — onboarding is the only thing that exists.
  pending: ["/onboarding"],
  admin: [
    "/dashboard",
    "/users",
    "/settings",
    "/queue",
    "/consult",
    "/prescribe",
    "/rounds",
    "/tasks",
    "/vitals",
    "/register",
    "/charges",
    "/invoice",
    "/reconciliation",
    ...STAFF_PATIENT_ACCESS,
  ],
  doctor: [
    "/queue",
    "/consult",
    "/prescribe",
    "/rounds",
    "/tasks",
    "/vitals",
    ...STAFF_PATIENT_ACCESS,
  ],
  // A nurse may read consultation notes but not author them — the screen itself
  // enforces that; billing is excluded from /consult entirely.
  nurse: ["/tasks", "/vitals", "/rounds", "/consult", ...STAFF_PATIENT_ACCESS],
  billing: [
    "/register",
    "/charges",
    "/invoice",
    "/reconciliation",
    ...STAFF_PATIENT_ACCESS,
  ],
  patient: ["/queue-status", "/reports"],
};

/** Reachable without a session. */
export const PUBLIC_PATHS = ["/login", "/signup"];

export function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function canAccess(role: Role, pathname: string) {
  return roleRoutes[role].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function homeFor(role: Role) {
  return roleHomePath[role];
}
