export const roles = ["doctor", "nurse", "billing", "admin"] as const;

export type Role = (typeof roles)[number];

/** Where each role lands after signing in. */
export const roleHomePath: Record<Role, string> = {
  doctor: "/queue",
  nurse: "/tasks",
  billing: "/register",
  admin: "/dashboard",
};
