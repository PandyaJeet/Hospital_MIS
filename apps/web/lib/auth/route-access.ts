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
    "/beds",
    "/labs",
    "/audit",
    ...STAFF_PATIENT_ACCESS,
  ],
  doctor: [
    "/queue",
    "/consult",
    "/prescribe",
    "/rounds",
    "/tasks",
    "/vitals",
    // register_patient() accepts any staff role, and a Tier 1 solo practice has
    // no receptionist — the doctor is the front desk. Withholding this made
    // patient registration unreachable for the product's smallest customer.
    "/register",
    // Beds are readable by every staff role and deliberately not tier-gated, so a
    // downgraded clinic can still see a patient who is lying in a bed
    // (ipd-beds.md §3).
    "/beds",
    "/labs",
    ...STAFF_PATIENT_ACCESS,
  ],
  // A nurse may read consultation notes but not author them — the screen itself
  // enforces that; billing is excluded from /consult entirely.
  nurse: [
    "/tasks",
    "/vitals",
    "/rounds",
    "/consult",
    "/register",
    "/beds",
    // A nurse records results and collects samples; there is no `lab_tech` role
    // (lab-orders.md §6). Ordering is still refused at the insert.
    "/labs",
    ...STAFF_PATIENT_ACCESS,
  ],
  billing: [
    "/register",
    "/charges",
    "/invoice",
    "/reconciliation",
    // Billing reads beds (a bed label is operational, and an inpatient bill has to
    // name the bed) and lab *orders* (a chargeable service), but never lab
    // *results* — the /labs screen shows them nothing clinical (lab-orders.md §2).
    "/beds",
    "/labs",
    ...STAFF_PATIENT_ACCESS,
  ],
  patient: ["/queue-status", "/reports"],
};

/**
 * Reachable without a session. `/invite` has to be public: an invitee arrives from
 * an emailed link before they have an account at all.
 */
export const PUBLIC_PATHS = ["/login", "/signup", "/invite"];

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
