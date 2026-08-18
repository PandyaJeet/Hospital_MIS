/**
 * The real role vocabulary from `docs/contracts/auth-tenancy.md` §2.
 *
 * `pending` is the state every user is in immediately after signup, before they
 * either found a clinic or accept an invite. It is a normal state, not an error
 * (§7) — a user can sit there indefinitely, so never redirect-loop it.
 */
export const roles = [
  "pending",
  "admin",
  "doctor",
  "nurse",
  "billing",
  "patient",
] as const;

export type Role = (typeof roles)[number];

/** Roles that can be assigned to a member of a tenant (everything but `pending`). */
export type AssignableRole = Exclude<Role, "pending">;

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

export function isShellRole(value: string): value is ShellRole {
  return (shellRoles as readonly string[]).includes(value);
}

/** Landing screen per role — auth-tenancy.md §7. */
export const roleHomePath: Record<Role, string> = {
  pending: "/onboarding",
  admin: "/dashboard",
  doctor: "/queue",
  nurse: "/tasks",
  billing: "/register",
  patient: "/queue-status",
};

/**
 * Roles that get the staff app shell (sidebar + top bar). `pending` has no
 * workspace yet and `patient` gets the deliberately minimal portal layout
 * (Design.md §8), so neither appears here.
 */
export const shellRoles = ["doctor", "nurse", "billing", "admin"] as const;

export type ShellRole = (typeof shellRoles)[number];
