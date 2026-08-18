import { USE_MOCK } from "@/lib/data/mock";
import { isRole, isShellRole, type Role, type ShellRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export interface SessionIdentity {
  role: Role | null;
  fullName: string | null;
}

/**
 * Server-side read of who is signed in, for chrome that renders before any
 * client JavaScript runs (sidebar, account menu).
 *
 * Doing this on the server rather than in the shell's own effect keeps the
 * sidebar from flickering through a wrong role on every navigation.
 */
export async function getSessionIdentity(): Promise<SessionIdentity> {
  // Mock mode has no cookie session — the mock user lives in module state in the
  // browser, so there is nothing for the server to read.
  if (USE_MOCK) return { role: null, fullName: null };

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { role: null, fullName: null };

  // Filter by id explicitly: an admin may read every profile in their tenant, so
  // an unfiltered query returns the whole staff list (auth-tenancy.md §2).
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  return {
    role: isRole(profile?.role ?? "") ? (profile!.role as Role) : null,
    fullName: profile?.full_name ?? null,
  };
}

/**
 * The role whose sidebar should be shown.
 *
 * Screens are grouped in the App Router by the role that owns them, but access is
 * broader than ownership — `/register` sits in `(billing)` yet any staff role may
 * use it (register_patient() accepts all of them). Keying the shell off the route
 * group would hand a doctor the billing sidebar and then bounce them off every
 * link in it. So the session wins, and the group's role is only a fallback for
 * mock mode, where there is no server-visible session.
 */
export async function getShellIdentity(
  fallback: ShellRole,
): Promise<{ role: ShellRole; fullName: string | null }> {
  const { role, fullName } = await getSessionIdentity();
  return {
    role: role && isShellRole(role) ? role : fallback,
    fullName,
  };
}
